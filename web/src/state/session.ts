/**
 * The editor's state and the actions on it.
 *
 * One module-level store rather than a class: there is exactly one open document, the same as the
 * reference app's single `EditorSession`. State is Vue-reactive; GPU textures are `markRaw` so the
 * reactivity system never proxies them.
 *
 * Every document change goes through `edit(label, body)`, which snapshots before and after and
 * only records an undo step when something actually changed.
 */

import { computed, markRaw, reactive, ref, shallowRef } from 'vue'

import { EditHistory } from '../model/history'
import * as doc from '../model/document'
import {
  DEFAULT_LIMITS,
  blendModeOf,
  effectiveOpacity,
  hierarchyEntries,
  indexLayers,
  isFolder,
  visibleLeaves,
  type AppLimits,
  type BlendModeName,
  type LayerRecord,
  type Manifest,
} from '../model/types'
import { Compositor, type LayerDraw } from '../render/compositor'
import {
  assetKey,
  backend,
  type AssetBytes,
  type OpenedProject,
} from './backend'

export interface ViewState {
  zoom: number
  panX: number
  panY: number
}

const project = shallowRef<OpenedProject | null>(null)
const manifest = ref<Manifest | null>(null)
const textures = reactive(new Map<string, GPUTexture>())
const selectedIds = ref<string[]>([])
const activeLayerId = ref<string | null>(null)
const collapsed = ref<Set<string>>(new Set())
const view = reactive<ViewState>({ zoom: 1, panX: 0, panY: 0 })
const viewport = reactive({ width: 1, height: 1, dpr: 1 })
const limits = ref<AppLimits>(DEFAULT_LIMITS)
const busy = ref(false)
const message = ref<string | null>(null)
const dirty = ref(false)
const compositor = shallowRef<Compositor | null>(null)
const canRender = ref(false)
const canGPU = ref(true)
const historyVersion = ref(0)

// `structuredClone` refuses a Vue proxy, and the document is JSON by definition, so the history
// snapshots are taken the same way the format serializes them.
const history = new EditHistory<Manifest>({
  limit: 200,
  clone: ((state: Manifest) => JSON.parse(JSON.stringify(state))) as <S>(state: S) => S,
})
let pendingBytes: AssetBytes = new Map()

// MARK: - Derived state

export const activeLayer = computed(() => {
  const id = activeLayerId.value
  if (!id || !manifest.value) return null
  return manifest.value.layers.find((layer) => layer.id === id) ?? null
})

export const rows = computed(() =>
  manifest.value
    ? hierarchyEntries(manifest.value.layers, { topFirst: true, collapsed: collapsed.value })
    : [],
)

export const canUndo = computed(() => historyVersion.value >= 0 && history.canUndo)
export const canRedo = computed(() => historyVersion.value >= 0 && history.canRedo)
export const undoLabel = computed(() => (historyVersion.value >= 0 ? history.undoLabel : null))
export const redoLabel = computed(() => (historyVersion.value >= 0 ? history.redoLabel : null))

/** What the compositor draws this frame, bottom to top. */
export const draws = computed<LayerDraw[]>(() => {
  const current = manifest.value
  if (!current) return []
  const byId = indexLayers(current)
  const result: LayerDraw[] = []
  for (const layer of visibleLeaves(current.layers)) {
    // Adjustment layers are in the file but this build does not render them yet.
    if (layer.adjustment !== undefined) continue
    if (isFolder(layer)) continue
    result.push({
      id: layer.id,
      texture: textures.get(assetKey(layer.id, 'image')) ?? null,
      mask: textures.get(assetKey(layer.id, 'mask')) ?? null,
      transform: layer.transform,
      opacity: effectiveOpacity(layer, byId),
      blendMode: blendModeOf(layer),
    })
  }
  return result
})

// MARK: - Reads

export function useSession() {
  return {
    project,
    manifest,
    selectedIds,
    activeLayerId,
    collapsed,
    view,
    viewport,
    limits,
    busy,
    message,
    dirty,
    canRender,
    canGPU,
    compositor,
    activeLayer,
    rows,
    draws,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
  }
}

export function hasTexture(layerId: string, kind: 'image' | 'mask' = 'image'): boolean {
  return textures.has(assetKey(layerId, kind))
}

// MARK: - History plumbing

function bumpHistory() {
  historyVersion.value += 1
}

/**
 * Runs a document change inside one undo step.
 *
 * `body` mutates `manifest.value` in place and reports whether anything changed; a body that
 * reports false — a slider dragged back to where it started — leaves no trace in the stack.
 */
function edit(label: string, body: (manifest: Manifest) => boolean | void): boolean {
  const current = manifest.value
  if (!current) return false
  history.begin(label, current)
  const changed = body(current)
  if (changed === false) {
    history.cancel()
    return false
  }
  const recorded = history.commit(current)
  if (recorded) {
    dirty.value = true
    bumpHistory()
  }
  return true
}

/**
 * Opens an undo step that spans a drag.
 *
 * A slider fires an input event per pixel of travel; recording each one would fill the stack with
 * a single gesture. `beginEdit` snapshots once, `applyEdit` mutates without recording, and
 * `endEdit` records the whole gesture as one step — and drops it entirely if nothing changed.
 */
export function beginEdit(label: string): void {
  const current = manifest.value
  if (current) history.begin(label, current)
}

/** Mutates the document without touching the undo stack. Must be inside a `beginEdit`…`endEdit`. */
export function applyEdit(body: (manifest: Manifest) => void): void {
  const current = manifest.value
  if (!current) return
  body(current)
}

/** Abandons the step `beginEdit` opened. */
export function historyCancel(): void {
  history.cancel()
}

/** Closes the step `beginEdit` opened, recording it only if the document actually changed. */
export function endEdit(): void {
  const current = manifest.value
  if (!current) return
  if (history.commit(current)) {
    dirty.value = true
    bumpHistory()
  }
}

export function undo(): void {
  const current = manifest.value
  if (!current) return
  const restored = history.undo(current)
  if (!restored) return
  manifest.value = restored
  dirty.value = true
  bumpHistory()
}

export function redo(): void {
  const current = manifest.value
  if (!current) return
  const restored = history.redo(current)
  if (!restored) return
  manifest.value = restored
  dirty.value = true
  bumpHistory()
}

// MARK: - Opening and saving

async function decodeAssets(opened: OpenedProject, target: Compositor): Promise<void> {
  const jobs = opened.assets.map(async (asset) => {
    try {
      const response = await fetch(asset.url)
      const blob = await response.blob()
      const bitmap = await createImageBitmap(blob)
      const texture = target.upload(assetKey(asset.layerId, asset.kind), bitmap, bitmap.width, bitmap.height)
      textures.set(assetKey(asset.layerId, asset.kind), markRaw(texture))
      bitmap.close()
    } catch (error) {
      console.warn(`could not decode ${asset.name}`, error)
    }
  })
  await Promise.all(jobs)
}

async function adopt(opened: OpenedProject): Promise<void> {
  project.value = opened
  manifest.value = opened.manifest
  textures.clear()
  pendingBytes = new Map()
  history.clear()
  bumpHistory()
  dirty.value = false
  selectedIds.value = []
  activeLayerId.value = opened.manifest.activeLayerID ?? opened.manifest.layers.at(-1)?.id ?? null
  collapsed.value = new Set()

  const target = compositor.value
  if (target) {
    target.setDocumentSize(opened.manifest.width, opened.manifest.height)
    await decodeAssets(opened, target)
  }
  fit()
}

export async function openProject(): Promise<void> {
  await guard(async () => {
    const opened = await (await backend()).openProject()
    if (!opened) return
    await adopt(opened)
    canRender.value = compositor.value !== null
  })
}

export async function newProject(width: number, height: number): Promise<void> {
  await guard(async () => {
    const opened = await (await backend()).createProject(width, height)
    if (!opened) return
    await adopt(opened)
    canRender.value = compositor.value !== null
  })
}

export async function saveProject(): Promise<void> {
  const current = manifest.value
  const opened = project.value
  if (!current || !opened) return
  await guard(async () => {
    const client = await backend()
    if (!client.writable) {
      message.value = 'This is a browser preview: nothing can be written to disk.'
      return
    }
    project.value = await client.saveProject(opened, current, pendingBytes)
    pendingBytes = new Map()
    dirty.value = false
    message.value = 'Saved'
  })
}

// MARK: - Layer actions

export function selectLayer(id: string, additive = false): void {
  activeLayerId.value = id
  if (additive) {
    selectedIds.value = selectedIds.value.includes(id)
      ? selectedIds.value.filter((other) => other !== id)
      : [...selectedIds.value, id]
  } else {
    selectedIds.value = [id]
  }
  const current = manifest.value
  if (current) current.activeLayerID = id
}

/** The layers an operation applies to: the multi-selection, or the active layer. */
export function targetIds(): string[] {
  if (selectedIds.value.length > 0) return selectedIds.value
  return activeLayerId.value ? [activeLayerId.value] : []
}

export function toggleCollapsed(id: string): void {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsed.value = next
}

export function addBlankLayer(): void {
  edit('New Layer', (current) => {
    const layer = doc.createLayer({
      name: `Layer ${current.layers.length + 1}`,
      transform: doc.covering(current.width, current.height),
      hasPixels: false,
    })
    doc.addLayer(current, layer)
    activeLayerId.value = layer.id
    selectedIds.value = [layer.id]
    return true
  })
}

export function addFolder(): void {
  edit('New Folder', (current) => {
    const folder = doc.createLayer({
      name: 'Folder',
      transform: doc.covering(current.width, current.height),
      isGroup: true,
    })
    doc.addLayer(current, folder)
    activeLayerId.value = folder.id
    selectedIds.value = [folder.id]
    return true
  })
}

export function deleteSelected(): void {
  edit('Delete Layers', (current) => {
    const ids = targetIds()
    if (!doc.removeLayers(current, ids)) return false
    activeLayerId.value = current.activeLayerID ?? null
    selectedIds.value = activeLayerId.value ? [activeLayerId.value] : []
    return true
  })
}

export function duplicateSelected(): void {
  edit('Duplicate Layer', (current) => {
    const ids = doc.topLevelSelection(current, targetIds())
    const clones: LayerRecord[] = []
    for (const id of ids) {
      const source = current.layers.find((layer) => layer.id === id)
      if (!source) continue
      const clone = JSON.parse(JSON.stringify(source)) as LayerRecord
      const id_ = doc.newUuid()
      clone.id = id_
      clone.name = `${source.name} copy`
      if (clone.imageFile) clone.imageFile = doc.imageFileName(id_)
      if (clone.maskFile) clone.maskFile = doc.maskFileName(id_)
      if (clone.parentID) delete clone.parentID
      // A copied layer has no pixels until one is painted or an asset is written for it.
      delete clone.imageFile
      delete clone.maskFile
      delete clone.maskEnabled
      clones.push(clone)
    }
    if (clones.length === 0) return false
    for (const clone of clones) current.layers.push(clone)
    activeLayerId.value = clones.at(-1)?.id ?? null
    selectedIds.value = activeLayerId.value ? [activeLayerId.value] : []
    return true
  })
}

export function moveActive(by: number): void {
  edit(by > 0 ? 'Move Layer Up' : 'Move Layer Down', (current) => {
    const id = activeLayerId.value
    if (!id) return false
    return doc.moveLayer(current, id, by)
  })
}

export function groupSelected(): void {
  edit('Group Layers', (current) => {
    const folderId = doc.groupLayers(current, targetIds())
    if (!folderId) return false
    activeLayerId.value = folderId
    selectedIds.value = [folderId]
    return true
  })
}

export function ungroupSelected(): void {
  edit('Ungroup Layers', (current) => {
    return doc.ungroupLayers(current, targetIds())
  })
}

export function toggleVisible(id: string): void {
  edit('Toggle Visibility', (current) => {
    const layer = current.layers.find((record) => record.id === id)
    if (!layer) return false
    layer.isVisible = !layer.isVisible
    return true
  })
}

export function setOpacity(id: string, opacity: number): void {
  edit('Opacity', (current) => {
    const layer = current.layers.find((record) => record.id === id)
    if (!layer) return false
    layer.opacity = opacity
    return true
  })
}

export function setBlendMode(id: string, mode: BlendModeName): void {
  edit('Blend Mode', (current) => {
    const layer = current.layers.find((record) => record.id === id)
    if (!layer || isFolder(layer)) return false
    layer.blendMode = mode
    return true
  })
}

export function renameLayer(id: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  edit('Rename Layer', (current) => {
    const layer = current.layers.find((record) => record.id === id)
    if (!layer || layer.name === trimmed) return false
    layer.name = trimmed
    return true
  })
}

export function setMaskSource(target: string, source: string | null): void {
  edit(source ? 'Create Clipping Mask' : 'Release Clipping Mask', (current) =>
    doc.setMaskSource(current, target, source),
  )
}

// MARK: - View

export function fit(): void {
  const current = manifest.value
  if (!current) return
  const available = { width: viewport.width / viewport.dpr, height: viewport.height / viewport.dpr }
  const padding = 48
  const zoom = Math.min(
    (available.width - padding) / current.width,
    (available.height - padding) / current.height,
    1,
  )
  view.zoom = Math.max(0.02, zoom)
  center()
}

export function center(): void {
  const current = manifest.value
  if (!current) return
  const available = { width: viewport.width / viewport.dpr, height: viewport.height / viewport.dpr }
  view.panX = (available.width - current.width * view.zoom) / 2
  view.panY = (available.height - current.height * view.zoom) / 2
}

export function zoomAt(factor: number, screenX: number, screenY: number): void {
  const before = view.zoom
  const after = Math.min(64, Math.max(0.02, before * factor))
  if (after === before) return
  // Keep the document point under the pointer where it is.
  const docX = (screenX - view.panX) / before
  const docY = (screenY - view.panY) / before
  view.zoom = after
  view.panX = screenX - docX * after
  view.panY = screenY - docY * after
}

export function zoomBy(factor: number): void {
  zoomAt(factor, viewport.width / viewport.dpr / 2, viewport.height / viewport.dpr / 2)
}

export function zoomTo(zoom: number): void {
  const before = view.zoom
  if (before === zoom) return
  zoomAt(zoom / before, viewport.width / viewport.dpr / 2, viewport.height / viewport.dpr / 2)
}

export function panBy(dx: number, dy: number): void {
  view.panX += dx
  view.panY += dy
}

/** Document coordinates for a point in CSS pixels within the canvas element. */
export function toDocument(screenX: number, screenY: number): [number, number] {
  return [(screenX - view.panX) / view.zoom, (screenY - view.panY) / view.zoom]
}

// MARK: - Export

export async function exportPNG(): Promise<void> {
  const target = compositor.value
  const current = manifest.value
  if (!target || !current) return
  await guard(async () => {
    const flattened = await target.flatten()
    if (!flattened) return
    const canvas = document.createElement('canvas')
    canvas.width = flattened.width
    canvas.height = flattened.height
    const context = canvas.getContext('2d')
    if (!context) return
    context.putImageData(new ImageData(new Uint8ClampedArray(flattened.data), flattened.width, flattened.height), 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) return
    await (await backend()).exportFile('composite.png', blob)
  })
}

// MARK: - Wiring

export async function attachCanvas(canvas: HTMLCanvasElement): Promise<void> {
  try {
    const target = await Compositor.create(canvas, {
      onError: (text) => {
        message.value = text
        console.error('[webgpu]', text)
      },
    })
    compositor.value = markRaw(target)
    limits.value = await (await backend()).limits()
    const current = manifest.value
    if (current) {
      target.setDocumentSize(current.width, current.height)
      const opened = project.value
      if (opened) await decodeAssets(opened, target)
    }
    canRender.value = true
  } catch (error) {
    canGPU.value = false
    message.value = error instanceof Error ? error.message : String(error)
  }
}

export function detachCanvas(): void {
  compositor.value?.destroy()
  compositor.value = null
  canRender.value = false
}

export function report(text: string | null): void {
  message.value = text
}

async function guard(work: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true
  message.value = null
  try {
    await work()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    message.value = text
    try {
      await (await backend()).reportError(text)
    } catch {
      // Reporting a failure must not itself fail the action.
    }
  } finally {
    busy.value = false
  }
}

/** Registers a decoded texture for a layer, used by tools that paint. */
export function putTexture(key: string, texture: GPUTexture): void {
  textures.set(key, markRaw(texture))
  pendingBytes.delete(key)
}

// A handle for scripted checks and for driving the app from the console. The desktop shell has no
// developer tools by default, so this is also the only way to inspect a running build.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__compositor', {
    value: {
      get manifest() {
        return manifest.value
      },
      get draws() {
        return draws.value
      },
      get textures() {
        return textures
      },
      get view() {
        return view
      },
      get compositor() {
        return compositor.value
      },
      get message() {
        return message.value
      },
      openProject,
      newProject,
      fit,
      undo,
      redo,
    },
    configurable: true,
  })
}

/** Marks an asset as rewritten, so a save writes bytes rather than copying the old file. */
export function markAssetBytes(key: string, bytes: Uint8Array): void {
  pendingBytes.set(key, bytes)
}

export function assetBytes(): AssetBytes {
  return pendingBytes
}
