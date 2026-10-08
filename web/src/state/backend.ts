/**
 * Where a project comes from and goes to.
 *
 * Two implementations: the Tauri one, which drives the Rust core, and a browser one that builds a
 * demo document in memory. The browser one exists so the canvas, the blend modes and the whole UI
 * can be developed and tested without launching the desktop shell — and so the app degrades to
 * something usable rather than a blank screen when it is opened in a plain browser.
 */

import {
  createManifest,
  createLayer,
  covering,
  imageFileName,
  maskFileName,
  newUuid,
} from '../model/document'
import {
  DEFAULT_LIMITS,
  type AppLimits,
  type Guide,
  type BlendModeName,
  type LayerRecord,
  type Manifest,
} from '../model/types'

export type AssetKind = 'image' | 'mask'

export interface AssetRef {
  layerId: string
  kind: AssetKind
  name: string
  /** Where it lives, for `link_asset`. Empty in the browser backend. */
  path: string
  width: number
  height: number
  /** Something an `ImageBitmap` can be decoded from. */
  url: string
}

export interface OpenedProject {
  /** The `.comp` folder. */
  path: string
  manifest: Manifest
  assets: AssetRef[]
}

/** Bytes to write for an asset, or `null` to copy the file the project already has. */
export type AssetBytes = Map<string, Uint8Array | null>

/** A file the user chose, already in memory. */
export interface PickedImage {
  name: string
  blob: Blob
}

export interface Backend {
  readonly kind: 'tauri' | 'browser'
  /** False in the browser: there is nowhere to write a project. */
  readonly writable: boolean
  openProject(): Promise<OpenedProject | null>
  /** Re-reads a project that is already open, for a reload after an outside change. */
  openProjectAt(path: string): Promise<OpenedProject>
  createProject(width: number, height: number): Promise<OpenedProject | null>
  saveProject(project: OpenedProject, manifest: Manifest, bytes: AssetBytes): Promise<OpenedProject>
  /** Shows a picker and returns whatever the user chose, or nothing. */
  pickImages(): Promise<PickedImage[]>
  /** Reads files the operating system dropped, which arrive as paths. */
  readFiles(paths: readonly string[]): Promise<PickedImage[]>
  /** Language packs installed outside the app, parsed. */
  listLanguagePacks(): Promise<unknown[]>
  /** Shows a picker, installs what is chosen, and returns it. */
  installLanguagePack(): Promise<unknown | null>
  /** Opens the folder packs are installed into, so one can be dropped in by hand. */
  openLanguageFolder(): Promise<void>
  limits(): Promise<AppLimits>
  exportFile(suggestedName: string, blob: Blob): Promise<void>
  reportError(message: string): Promise<void>
}

export function assetKey(layerId: string, kind: AssetKind): string {
  return `${layerId}|${kind}`
}

// MARK: - Tauri

interface RawAsset {
  layerId: string
  kind: AssetKind
  name: string
  path: string
  width: number
  height: number
}

interface RawProject {
  path: string
  manifest: Manifest
  assets: RawAsset[]
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']
const PACK_STORAGE_KEY = 'compositor.languagePacks'

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

async function tauriBackend(): Promise<Backend> {
  const { invoke, convertFileSrc } = await import('@tauri-apps/api/core')
  const dialog = await import('@tauri-apps/plugin-dialog')

  const readFiles = async (paths: readonly string[]): Promise<PickedImage[]> => {
    const picked: PickedImage[] = []
    for (const path of paths) {
      try {
        // The Rust side answers with the bytes as a raw body, so a 40 MB image is not doubled by
        // being written out as a JSON array of numbers on the way past.
        const buffer = await invoke<ArrayBuffer>('read_file', { path })
        picked.push({ name: fileName(path), blob: new Blob([buffer]) })
      } catch (error) {
        console.error(`could not read ${path}`, error)
      }
    }
    return picked
  }

  const toOpened = (raw: RawProject): OpenedProject => ({
    path: raw.path,
    manifest: raw.manifest,
    assets: raw.assets.map((asset) => ({ ...asset, url: convertFileSrc(asset.path) })),
  })

  return {
    kind: 'tauri',
    writable: true,

    async openProject() {
      const chosen = await dialog.open({
        title: 'Open Project',
        directory: true,
        multiple: false,
      })
      if (!chosen) return null
      const path = typeof chosen === 'string' ? chosen : chosen[0]
      const raw = await invoke<RawProject>('open_project', { path })
      return toOpened(raw)
    },

    async openProjectAt(path) {
      const raw = await invoke<RawProject>('open_project', { path })
      return toOpened(raw)
    },

    async createProject(width, height) {
      const chosen = await dialog.save({
        title: 'New Project',
        defaultPath: 'Untitled.comp',
      })
      if (!chosen) return null
      const path = ensureExtension(chosen, '.comp')
      const raw = await invoke<RawProject>('create_project', { path, width, height })
      return toOpened(raw)
    },

    async saveProject(project, manifest, bytes) {
      const session = await invoke<string>('begin_save', { target: project.path })
      try {
        for (const asset of project.assets) {
          const key = assetKey(asset.layerId, asset.kind)
          // A layer that still exists and has not been painted on keeps its file as it is.
          const declared = declaredName(manifest, asset.layerId, asset.kind)
          if (!declared) continue
          const replacement = bytes.get(key)
          if (replacement === null || replacement === undefined) {
            await invoke('link_asset', { session, name: declared, source: asset.path })
          } else {
            await invoke('write_asset', replacement, {
              headers: { 'x-session': session, 'x-name': declared },
            })
          }
        }
        for (const [key, data] of bytes) {
          if (!data) continue
          const [layerId, kind] = key.split('|') as [string, AssetKind]
          if (project.assets.some((asset) => assetKey(asset.layerId, asset.kind) === key)) continue
          const declared = declaredName(manifest, layerId, kind)
          if (!declared) continue
          await invoke('write_asset', data, {
            headers: { 'x-session': session, 'x-name': declared },
          })
        }
        await invoke('commit_save', { session, manifest })
      } catch (error) {
        await invoke('abort_save', { session }).catch(() => undefined)
        throw error
      }
      return { ...project, manifest }
    },

    async pickImages() {
      const chosen = await dialog.open({
        title: 'Import Images',
        multiple: true,
        filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }],
      })
      if (!chosen) return []
      const paths = Array.isArray(chosen) ? chosen : [chosen]
      return readFiles(paths)
    },

    readFiles,

    async listLanguagePacks() {
      return invoke<unknown[]>('list_language_packs')
    },

    async installLanguagePack() {
      const chosen = await dialog.open({
        title: 'Install Language Pack',
        multiple: false,
        filters: [{ name: 'Language pack', extensions: ['json'] }],
      })
      if (!chosen) return null
      const path = typeof chosen === 'string' ? chosen : chosen[0]
      return invoke<unknown>('install_language_pack', { path })
    },

    async openLanguageFolder() {
      await invoke('open_language_folder')
    },

    async limits() {
      return invoke<AppLimits>('read_app_limits')
    },

    async exportFile(suggestedName, blob) {
      const chosen = await dialog.save({ title: 'Export', defaultPath: suggestedName })
      if (!chosen) return
      const bytes = new Uint8Array(await blob.arrayBuffer())
      await invoke('write_file', bytes, {
        headers: { 'x-path': base64url(chosen) },
      })
    },

    async reportError(message) {
      await dialog.message(message, { title: 'Compositor', kind: 'error' })
    },
  }
}

/** The name a manifest declares for one of a layer's assets. */function declaredName(manifest: Manifest, layerId: string, kind: AssetKind): string | null {
  const layer = manifest.layers.find((record) => record.id === layerId)
  if (!layer) return null
  return (kind === 'image' ? layer.imageFile : layer.maskFile) ?? null
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** A `.comp` path that ends in `.comp`, since a save dialog will not insist on it. */
function ensureExtension(path: string, extension: string): string {
  return path.toLowerCase().endsWith(extension) ? path : `${path}${extension}`
}

// MARK: - Browser

/** A small document built from `OffscreenCanvas`, so the app has something to show. */
async function demoProject(): Promise<OpenedProject> {
  const width = 960
  const height = 640
  const manifest = createManifest(width, height)
  const assets: AssetRef[] = []
  const drawn: Array<[LayerRecord, (context: OffscreenCanvasRenderingContext2D) => void]> = []

  const background = createLayer({ name: 'Background', transform: covering(width, height), hasPixels: true })
  drawn.push([
    background,
    (context) => {
      const gradient = context.createLinearGradient(0, 0, width, height)
      gradient.addColorStop(0, '#1b2a4a')
      gradient.addColorStop(0.5, '#3f6ea8')
      gradient.addColorStop(1, '#f0a35e')
      context.fillStyle = gradient
      context.fillRect(0, 0, width, height)
      context.globalAlpha = 0.25
      context.strokeStyle = '#ffffff'
      context.lineWidth = 2
      for (let x = 0; x < width; x += 40) {
        context.beginPath()
        context.moveTo(x, 0)
        context.lineTo(x, height)
        context.stroke()
      }
    },
  ])

  const disc = createLayer({ name: 'Disc', transform: covering(width, height), hasPixels: true })
  disc.blendMode = 'Overlay' as BlendModeName
  disc.opacity = 0.85
  drawn.push([
    disc,
    (context) => {
      const gradient = context.createRadialGradient(width / 2, height / 2, 20, width / 2, height / 2, 320)
      gradient.addColorStop(0, 'rgba(255, 240, 200, 0.95)')
      gradient.addColorStop(1, 'rgba(255, 120, 60, 0)')
      context.fillStyle = gradient
      context.beginPath()
      context.arc(width / 2, height / 2, 320, 0, Math.PI * 2)
      context.fill()
    },
  ])

  const bars = createLayer({ name: 'Bars', transform: covering(width, height), hasPixels: true })
  bars.blendMode = 'Screen' as BlendModeName
  drawn.push([
    bars,
    (context) => {
      context.fillStyle = 'rgba(120, 220, 255, 0.9)'
      for (let index = 0; index < 8; index += 1) {
        context.fillRect(80 + index * 100, height - 120 - index * 24, 48, 120 + index * 24)
      }
    },
  ])

  const folder = createLayer({ name: 'Folder', transform: covering(width, height), isGroup: true })
  folder.opacity = 0.6
  const inside = createLayer({
    name: 'Inside',
    transform: { ...covering(width, height), origin: [40, 400], size: [360, 200], rotation: -6 },
    hasPixels: true,
    parentID: folder.id,
  })
  inside.blendMode = 'Soft Light' as BlendModeName
  drawn.push([
    inside,
    (context) => {
      context.fillStyle = '#ffd166'
      context.font = 'bold 64px sans-serif'
      context.textBaseline = 'middle'
      context.fillText('Compositor', 24, 100)
    },
  ])

  const mask = createLayer({ name: 'Masked', transform: covering(width, height), hasPixels: true })
  mask.maskFile = maskFileName(mask.id)
  mask.maskEnabled = true
  drawn.push([
    mask,
    (context) => {
      context.fillStyle = '#ff3b6b'
      context.fillRect(0, 0, width, height)
    },
  ])

  manifest.layers = [background, disc, bars, folder, inside, mask]
  manifest.activeLayerID = disc.id
  manifest.guides = [
    { id: newUuid(), axis: 'vertical', position: width / 2 },
    { id: newUuid(), axis: 'horizontal', position: height / 3 },
  ] as Guide[]

  for (const [layer, paint] of drawn) {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) continue
    paint(context)
    const blob = await blobOf(canvas)
    assets.push({
      layerId: layer.id,
      kind: 'image',
      name: imageFileName(layer.id),
      path: '',
      width,
      height,
      url: URL.createObjectURL(blob),
    })
  }

  // A soft left-to-right mask on the last layer.
  const maskCanvas = new OffscreenCanvas(width, height)
  const maskContext = maskCanvas.getContext('2d')!
  const maskGradient = maskContext.createLinearGradient(0, 0, width, 0)
  maskGradient.addColorStop(0, '#000000')
  maskGradient.addColorStop(0.45, '#ffffff')
  maskGradient.addColorStop(1, '#ffffff')
  maskContext.fillStyle = maskGradient
  maskContext.fillRect(0, 0, width, height)
  const maskBlob = await blobOf(maskCanvas)
  assets.push({
    layerId: mask.id,
    kind: 'mask',
    name: maskFileName(mask.id),
    path: '',
    width,
    height,
    url: URL.createObjectURL(maskBlob),
  })

  // A path, so the reload path has something to reload from. A browser has no folder behind it.
  return { path: 'demo.comp', manifest, assets }
}

/** Browser canvas blobs are made synchronously at module scope, so this is a promise for shape. */
async function blobOf(canvas: OffscreenCanvas): Promise<Blob> {
  return canvas.convertToBlob({ type: 'image/png' })
}

function browserBackend(): Backend {
  let current: OpenedProject | null = null
  return {
    kind: 'browser',
    writable: false,

    async openProject() {
      // The manifest is cloned on every open. Handing back the same object would mean editing a
      // document and reopening it showed the edits still applied, which is not what reopening a
      // file does anywhere else.
      current ??= await demoProject()
      return { ...current, manifest: structuredClone(current.manifest) }
    },

    async openProjectAt() {
      // A browser has no files to watch, so this is only ever reached from a reload.
      current ??= await demoProject()
      return { ...current, manifest: structuredClone(current.manifest) }
    },

    async createProject() {
      current = await demoProject()
      return { ...current, manifest: structuredClone(current.manifest) }
    },

    async saveProject(project, manifest) {
      // Nothing to write to, but the in-memory document stays consistent so the UI behaves.
      return { ...project, manifest }
    },

    async pickImages() {
      const picked = await pickWithInput(IMAGE_EXTENSIONS)
      return picked
    },

    async readFiles() {
      // A browser is not handed a path; dropping a file in gives the bytes directly.
      return []
    },

    async listLanguagePacks() {
      const stored = localStorage.getItem(PACK_STORAGE_KEY)
      if (!stored) return []
      try {
        const parsed: unknown = JSON.parse(stored)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    },

    async installLanguagePack() {
      const [file] = await pickWithInput(['.json'])
      if (!file) return null
      const text = await file.blob.text()
      const value: unknown = JSON.parse(text)
      const list = await this.listLanguagePacks()
      const kept = list.filter((entry) => (entry as { locale?: string }).locale !== (value as { locale?: string }).locale)
      // Local storage stands in for the data folder the desktop build writes to.
      localStorage.setItem(PACK_STORAGE_KEY, JSON.stringify([...kept, value]))
      return value
    },

    async openLanguageFolder() {
      // A browser has no folder to open; the pack is kept in local storage instead.
    },

    async limits() {
      return DEFAULT_LIMITS
    },

    async exportFile(suggestedName, blob) {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = suggestedName
      anchor.click()
      URL.revokeObjectURL(url)
    },

    async reportError(message) {
      // eslint-disable-next-line no-alert
      window.alert(message)
    },
  }
}

/** A hidden `<input type="file">`, the only way a browser gives up a file the user chose. */
function pickWithInput(extensions: readonly string[]): Promise<PickedImage[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = extensions.map((extension) => `.${extension}`).join(',')
    input.multiple = true
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])].map((file) => ({ name: file.name, blob: file }))
      resolve(files)
    })
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
}

let cached: Promise<Backend> | null = null

/** Picks the Tauri backend when running inside the desktop shell, the browser one otherwise. */
export function backend(): Promise<Backend> {
  cached ??= (async () => {
    const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    return inTauri ? tauriBackend() : browserBackend()
  })()
  return cached
}
