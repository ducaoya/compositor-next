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
  applyPack,
  availableLocales,
  currentLocale,
  isPackProblem,
  setLocale,
  t,
  translateError,
  validatePack,
  type LocaleInfo,
} from '../i18n'
import {
  ellipseSelection,
  fullSelection,
  inverted,
  maskSelection,
  rectSelection,
  selectionContains,
  withMask,
  type Selection,
} from '../model/selection'
import {
  blurMask,
  dilateMask,
  erodeMask,
  invertMask,
  magicWandMask,
  maskFromShape,
  type Mask,
} from '../model/selectionMask'
import { SHORTCUT_CYCLES, type ToolId } from '../model/tools'
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
import { Compositor, type DrawItem } from '../render/compositor'
import {
  ADJUSTMENT_KINDS,
  buildLut,
  identityAdjustment,
  type AdjustmentKind,
  type LayerAdjustment,
} from '../model/adjustments'
import { PaintStore, fillSurface, stampSegment, type BrushSettings, type LayerSurface } from '../render/paint'
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
/** Every WebGPU diagnostic seen this session, newest last. A single `message` slot loses the first
 *  of a cascade, and the first is the one that explains the rest. */
const gpuErrors = ref<string[]>([])
const canGPU = ref(true)
const historyVersion = ref(0)

// MARK: - Tools, colours and painting

const tool = ref<ToolId>('move')
const previousTool = ref<ToolId>('move')
const foreground = reactive({ r: 235, g: 235, b: 235 })
const background = reactive({ r: 255, g: 255, b: 255 })
const brush = reactive<BrushSettings>({
  size: 32,
  hardness: 0.8,
  opacity: 1,
  flow: 1,
  color: { r: 235, g: 235, b: 235 },
})
const selection = ref<Selection | null>(null)
/**
 * The selection's coverage as a canvas, for the brush and the fill.
 *
 * Built when the selection changes rather than per dab: a brush stamp is the hottest path in the
 * app, and turning a mask into an image there would be the whole cost of painting.
 */
const selectionMaskCanvas = shallowRef<OffscreenCanvas | null>(null)
/** What the user is being asked for: a feather radius, or how far to grow or shrink. */
export const selectionAmountPrompt = reactive({
  open: false,
  mode: 'feather' as 'feather' | 'expand' | 'contract',
  amount: 5,
})
const paintStore = new PaintStore()
/** Decoded pixel sizes, for mapping between layer pixels and the document. */
const layerImages = reactive(new Map<string, { width: number; height: number }>())
/** Which layers the brush changes colour with, so an erase uses the eraser tip. */
const erasing = ref(false)
/** The Magic Wand's settings, which its options bar edits. */
const wandTolerance = ref(32)
const wandContiguous = ref(true)

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

/** What the compositor draws this frame, bottom to top: layers and adjustments in stack order. */
export const draws = computed<DrawItem[]>(() => {
  const current = manifest.value
  if (!current) return []
  const byId = indexLayers(current)
  const result: DrawItem[] = []
  for (const layer of visibleLeaves(current.layers)) {
    if (isFolder(layer)) continue
    const opacity = effectiveOpacity(layer, byId)
    // An adjustment layer changes what is below it rather than drawing anything of its own, which
    // is why it goes into the same list: order is what decides what it applies to.
    if (layer.adjustment !== undefined) {
      result.push({
        kind: 'adjustment',
        id: layer.id,
        opacity,
        adjustment: layer.adjustment as LayerAdjustment,
        mask: textures.get(assetKey(layer.id, 'mask')) ?? null,
      })
      continue
    }
    result.push({
      kind: 'layer',
      id: layer.id,
      texture: textures.get(assetKey(layer.id, 'image')) ?? null,
      mask: textures.get(assetKey(layer.id, 'mask')) ?? null,
      transform: layer.transform,
      opacity,
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
    tool,
    foreground,
    background,
    brush,
    selection,
    erasing,
    locales,
    locale,
    activeAdjustment,
    gpuErrors,
    selectionMaskCanvas,
    wandTolerance,
    wandContiguous,
  }
}

export function hasTexture(layerId: string, kind: 'image' | 'mask' = 'image'): boolean {
  return textures.has(assetKey(layerId, kind))
}

/** Which languages the picker offers, and which one is active. */
const locales = ref<LocaleInfo[]>(availableLocales())
const locale = ref(currentLocale())

/**
 * Loads the packs installed outside the app.
 *
 * Called at startup and whenever the user asks for a reload, so a pack dropped into the data
 * folder by hand — or one just installed — takes effect without a restart.
 */
export async function loadLanguagePacks(): Promise<void> {
  try {
    const client = await backend()
    for (const value of await client.listLanguagePacks()) {
      const pack = validatePack(value)
      // A pack that does not fit the shape is skipped rather than fatal: one broken file should not
      // cost the user every other language.
      if (!isPackProblem(pack)) applyPack(pack)
    }
  } catch (error) {
    console.warn('language packs could not be listed', error)
  }
  locales.value = availableLocales()
  locale.value = currentLocale()
}

/** Shows a picker, installs what is chosen, and switches to it. */
export async function installLanguagePack(): Promise<void> {
  await guard(async () => {
    const client = await backend()
    const value = await client.installLanguagePack()
    if (!value) return
    const pack = validatePack(value)
    if (isPackProblem(pack)) {
      message.value = t('language.installedError', { reason: pack.reason })
      return
    }
    applyPack(pack)
    locales.value = availableLocales()
    locale.value = pack.locale
    setLocale(pack.locale)
    message.value = t('message.packInstalled', { name: pack.name })
  })
}

export function chooseLocale(code: string): void {
  setLocale(code)
  locale.value = code
}

export async function openLanguageFolder(): Promise<void> {
  await guard(async () => {
    await (await backend()).openLanguageFolder()
  })
}

export async function reloadLanguagePacks(): Promise<void> {
  await guard(async () => {
    await loadLanguagePacks()
    message.value = t('language.reloaded')
  })
}

/** Translates for template code that has no setup context, such as the menu model. */
export { t as translate }

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

/** The new-canvas size prompt, opened from the toolbar. */
export const newCanvasPrompt = reactive({ open: false, width: 1920, height: 1080 })

export function openNewCanvasPrompt(): void {
  newCanvasPrompt.open = true
}

/** The colour a tool uses when it paints: the foreground well, kept in step with the brush. */
export function setForeground(color: { r: number; g: number; b: number }): void {
  foreground.r = color.r
  foreground.g = color.g
  foreground.b = color.b
  brush.color = { ...color }
}

export function swapColors(): void {
  const f = { r: foreground.r, g: foreground.g, b: foreground.b }
  setForeground({ r: background.r, g: background.g, b: background.b })
  background.r = f.r
  background.g = f.g
  background.b = f.b
}

export function resetColors(): void {
  background.r = 255
  background.g = 255
  background.b = 255
  setForeground({ r: 0, g: 0, b: 0 })
}

/** Picks a tool, remembering where Alt-tabbing back to it should return. */
export function selectTool(id: ToolId): void {
  if (tool.value === id) return
  previousTool.value = tool.value
  tool.value = id
  erasing.value = id === 'eraser'
}

/** Cycles the tools that share a shortcut, as pressing the key repeatedly does in Photoshop. */
export function cycleTool(shortcut: string): void {
  const cycle = SHORTCUT_CYCLES[shortcut]
  if (!cycle || cycle.length === 0) return
  const at = cycle.indexOf(tool.value)
  selectTool(cycle[(at + 1) % cycle.length])
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
      const key = assetKey(asset.layerId, asset.kind)
      const texture = target.setLayerTexture(key, bitmap, bitmap.width, bitmap.height)
      textures.set(key, markRaw(texture))
      if (asset.kind === 'image') {
        layerImages.set(asset.layerId, { width: bitmap.width, height: bitmap.height })
        // The paint surface is seeded from the same pixels the GPU got. Keeping the raster on the
        // CPU as well is what makes the brush, the eyedropper and saving possible; it is also the
        // one place this build holds a document's pixels twice.
        paintStore.create(asset.layerId, bitmap, bitmap.width, bitmap.height)
      }
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
  paintStore.clear()
  layerImages.clear()
  selection.value = null
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
      message.value = t('message.browserPreview')
      return
    }
    project.value = await client.saveProject(opened, current, pendingBytes)
    pendingBytes = new Map()
    dirty.value = false
    message.value = t('message.saved')
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

/** The adjustment on the active layer, if it has one. */
export const activeAdjustment = computed<LayerAdjustment | null>(() => {
  const layer = activeLayer.value
  if (!layer || layer.adjustment === undefined) return null
  return layer.adjustment as LayerAdjustment
})

/** Adds an adjustment layer above the active one, at the canvas rectangle. */
export function addAdjustment(kind: AdjustmentKind): void {
  const current = manifest.value
  if (!current) return
  edit(`New ${kind} Layer`, (manifestNow) => {
    const layer = doc.createLayer({
      name: kind,
      transform: doc.covering(manifestNow.width, manifestNow.height),
    })
    layer.adjustment = identityAdjustment(kind)
    const at = activeLayerId.value
      ? manifestNow.layers.findIndex((record) => record.id === activeLayerId.value) + 1
      : manifestNow.layers.length
    doc.addLayer(manifestNow, layer, at)
    activeLayerId.value = layer.id
    selectedIds.value = [layer.id]
    return true
  })
}

/**
 * Merges a change into the active adjustment.
 *
 * Inside a drag the caller wraps this in `beginEdit`/`endEdit`, so a slider is one undo step
 * rather than one per input event.
 */
export function patchAdjustment(patch: Record<string, unknown>): void {
  const layer = activeLayer.value
  if (!layer || layer.adjustment === undefined) return
  const adjustment = layer.adjustment as LayerAdjustment
  Object.assign(adjustment, patch)
}

/** Merges a change into one of the adjustment's settings blocks. */
export function patchAdjustmentSettings(key: string, patch: Record<string, unknown>): void {
  const layer = activeLayer.value
  if (!layer || layer.adjustment === undefined) return
  const adjustment = layer.adjustment as LayerAdjustment
  const existing = (adjustment[key] as Record<string, unknown> | undefined) ?? {}
  adjustment[key] = { ...existing, ...patch }
}

/** Whether an adjustment's settings are the identity, so the panel can say so. */
export function adjustmentIsIdentity(adjustment: LayerAdjustment): boolean {
  const lut = buildLut(adjustment)
  if (lut) {
    for (let value = 0; value < 256; value += 1) {
      if (lut[value] !== value || lut[256 + value] !== value || lut[512 + value] !== value) return false
    }
    return true
  }
  return false
}

export { ADJUSTMENT_KINDS }

// MARK: - Layer and document coordinates

/** The image size a layer's own pixels have, which its transform places on the document. */
export function layerPixelSize(layer: LayerRecord): { width: number; height: number } {
  const known = layerImages.get(layer.id)
  if (known) return known
  const surface = paintStore.surface(layer.id)
  if (surface) return { width: surface.width, height: surface.height }
  return { width: Math.max(1, Math.round(layer.transform.size[0])), height: Math.max(1, Math.round(layer.transform.size[1])) }
}

/**
 * How a layer's pixels land on the document, as a matrix.
 *
 * Layer pixel (0, 0) is the image's top-left; the transform puts that corner at `origin` and
 * stretches the image to `size`, then rotates it about the centre and applies the flips. Building
 * it as a matrix rather than as a point conversion means the selection clip can go through the
 * same mapping, so a rotated or flipped layer hides nothing and paints in the right place.
 */
export function layerMatrix(layer: LayerRecord): DOMMatrix {
  const { width, height } = layerPixelSize(layer)
  const [w, h] = layer.transform.size
  const [ox, oy] = layer.transform.origin
  const matrix = new DOMMatrix()
  matrix.translateSelf(ox + w / 2, oy + h / 2)
  matrix.rotateSelf(layer.transform.rotation)
  matrix.scaleSelf(w, h)
  matrix.translateSelf(-0.5, -0.5)
  matrix.translateSelf(layer.transform.flipX ? 1 : 0, layer.transform.flipY ? 1 : 0)
  matrix.scaleSelf(layer.transform.flipX ? -1 : 1, layer.transform.flipY ? -1 : 1)
  matrix.scaleSelf(1 / width, 1 / height)
  return matrix
}

/** Where a document point lands in a layer's own pixels. */
export function documentToLayer(layer: LayerRecord, x: number, y: number): [number, number] {
  try {
    const point = layerMatrix(layer).inverse().transformPoint(new DOMPoint(x, y))
    return [point.x, point.y]
  } catch {
    return [x, y]
  }
}

/** Document pixels per layer pixel, for scaling a brush tip onto the document. */
export function layerPixelScale(layer: LayerRecord): number {
  const { width, height } = layerPixelSize(layer)
  const scaleX = layer.transform.size[0] / Math.max(width, 1)
  const scaleY = layer.transform.size[1] / Math.max(height, 1)
  return Math.max(1e-6, (scaleX + scaleY) / 2)
}

function currentSelectionClip(layer: LayerRecord): import('../render/paint').SelectionClip | null {
  if (!selection.value || !manifest.value) return null
  const matrix = layerMatrix(layer)
  return {
    selection: selection.value,
    canvasWidth: manifest.value.width,
    canvasHeight: manifest.value.height,
    layerToDocument: matrix,
    maskCanvas: selectionMaskCanvas.value,
    documentToLayer: matrix.inverse(),
  }
}

/** The layer a paint action works on: the active one, or null when it cannot be painted. */
export function paintableLayer(): LayerRecord | null {
  const layer = activeLayer.value
  if (!layer) return null
  if (isFolder(layer)) return null
  if (layer.adjustment !== undefined) return null
  return layer
}

/** The surface for a layer, made from its pixels if it does not have one yet. */
export function ensureSurface(layer: LayerRecord): LayerSurface {
  const { width, height } = layerPixelSize(layer)
  return paintStore.ensure(layer.id, width, height)
}

// MARK: - Painting

let strokeLayer: string | null = null
let strokeLast: [number, number] | null = null
let strokeSmoothed: [number, number] | null = null

/** Alt on a brush turns it into the other one, as Photoshop's Option/Alt does. */
function brushErasing(): boolean {
  return tool.value === 'eraser'
}

export function beginStroke(x: number, y: number): void {
  const layer = paintableLayer()
  if (!layer) return
  const surface = ensureSurface(layer)
  const clip = currentSelectionClip(layer)
  const [lx, ly] = documentToLayer(layer, x, y)
  const radius = (brush.size / 2) / layerPixelScale(layer)

  history.begin('Brush', manifest.value!)
  // A layer that had no pixels now has some, which is what makes it save.
  if (!layer.imageFile) layer.imageFile = doc.imageFileName(layer.id)
  layerImages.set(layer.id, { width: surface.width, height: surface.height })

  strokeLayer = layer.id
  strokeLast = [lx, ly]
  strokeSmoothed = [lx, ly]
  surface.dirty = unionDirty(
    surface.dirty,
    stampSegment(surface, [lx, ly], [lx, ly], radius, brush, brushErasing(), clip),
  )
}

export function extendStroke(x: number, y: number): void {
  if (!strokeLayer || !strokeLast) return
  const layer = manifest.value?.layers.find((record) => record.id === strokeLayer)
  const surface = paintStore.surface(strokeLayer)
  if (!layer || !surface) return

  const [lx, ly] = documentToLayer(layer, x, y)
  // Smoothing trails the pointer, which is what makes a hand-drawn edge look drawn rather than
  // sampled: Photoshop calls the same knob Smoothing.
  const smoothing = 0.35
  const target: [number, number] = [
    (strokeSmoothed?.[0] ?? lx) + (lx - (strokeSmoothed?.[0] ?? lx)) * (1 - smoothing),
    (strokeSmoothed?.[1] ?? ly) + (ly - (strokeSmoothed?.[1] ?? ly)) * (1 - smoothing),
  ]
  strokeSmoothed = target

  const radius = (brush.size / 2) / layerPixelScale(layer)
  surface.dirty = unionDirty(
    surface.dirty,
    stampSegment(surface, strokeLast, target, radius, brush, brushErasing(), currentSelectionClip(layer)),
  )
  strokeLast = target
}

export function endStroke(): void {
  strokeLayer = null
  strokeLast = null
  strokeSmoothed = null
  if (history.isEditing) endEdit()
  schedulePaintFlush()
}

function unionDirty(
  a: import('../render/paint').DirtyRect | null,
  b: import('../render/paint').DirtyRect | null,
): import('../render/paint').DirtyRect | null {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

/** Floods the layer with a colour, or clears it when `color` is null. */
export function fillLayer(color: { r: number; g: number; b: number } | null): void {
  const layer = paintableLayer()
  if (!layer) return
  const surface = ensureSurface(layer)
  edit(color ? 'Fill' : 'Clear', (current) => {
    const record = current.layers.find((item) => item.id === layer.id)
    if (!record) return false
    if (!record.imageFile) record.imageFile = doc.imageFileName(record.id)
    layerImages.set(record.id, { width: surface.width, height: surface.height })
    fillSurface(surface, color, currentSelectionClip(record))
    return true
  })
  schedulePaintFlush()
}

/** Reads the colour of the topmost layer under a document point. */
export function pickColor(x: number, y: number): boolean {
  const current = manifest.value
  if (!current) return false
  const byId = indexLayers(current)
  const leaves = visibleLeaves(current.layers).filter(
    (layer) => !isFolder(layer) && layer.isVisible !== false,
  )
  for (let index = leaves.length - 1; index >= 0; index -= 1) {
    const layer = leaves[index]
    void byId
    const surface = paintStore.surface(layer.id)
    if (!surface) continue
    const [lx, ly] = documentToLayer(layer, x, y)
    if (lx < 0 || ly < 0 || lx >= surface.width || ly >= surface.height) continue
    const pixel = surface.context.getImageData(Math.floor(lx), Math.floor(ly), 1, 1).data
    if (pixel[3] < 8) continue
    setForeground({ r: pixel[0], g: pixel[1], b: pixel[2] })
    return true
  }
  return false
}

// MARK: - Selections

export function setSelection(next: Selection | null): void {
  selection.value = next
  selectionMaskCanvas.value = next?.mask ? maskToCanvas(next.mask) : null
}

/** The coverage as an image whose alpha is the selection. */
function maskToCanvas(mask: Mask): OffscreenCanvas | null {
  const canvas = new OffscreenCanvas(mask.width, mask.height)
  const context = canvas.getContext('2d')
  if (!context) return null
  const image = new ImageData(mask.width, mask.height)
  for (let index = 0; index < mask.data.length; index += 1) {
    image.data[index * 4] = 255
    image.data[index * 4 + 1] = 255
    image.data[index * 4 + 2] = 255
    image.data[index * 4 + 3] = mask.data[index]
  }
  context.putImageData(image, 0, 0)
  return canvas
}

/**
 * The selection as coverage, whatever form it currently takes.
 *
 * A shape is rasterised on demand, which is what lets Feather follow a marquee drag without the
 * marquee having to build a mask on every pointer move.
 */
function selectionAsMask(): Mask | null {
  const current = selection.value
  const manifestNow = manifest.value
  if (!current || !manifestNow) return null
  if (current.mask) return current.mask
  if (current.kind === 'mask') return null
  const mask = maskFromShape(
    { kind: current.kind, bounds: { x: current.x, y: current.y, width: current.width, height: current.height }, points: current.points },
    manifestNow.width,
    manifestNow.height,
  )
  return current.inverted ? invertMask(mask) : mask
}

/** Feather, Expand, Contract and the wand all land here. */
function applySelectionMask(mask: Mask | null, label: string): void {
  if (!mask) {
    setSelection(null)
    return
  }
  const next = maskSelection(mask)
  // The shape is kept so the marching ants keep their outline; the coverage is what counts.
  const current = selection.value
  setSelection(current && current.kind !== 'mask' ? { ...withMask(current, mask), kind: current.kind } : next)
  void label
}

export function promptSelectionAmount(mode: 'feather' | 'expand' | 'contract'): void {
  if (!selection.value) return
  selectionAmountPrompt.mode = mode
  selectionAmountPrompt.amount = mode === 'feather' ? 5 : 5
  selectionAmountPrompt.open = true
}

/** Softens the edge of the selection by `radius`, the same Gaussian the reference uses. */
export function featherSelection(radius: number): void {
  const mask = selectionAsMask()
  if (!mask || radius <= 0) return
  setSelection(null)
  applySelectionMask(blurMask(mask, radius / 2), 'Feather')
}

export function expandSelection(amount: number): void {
  const mask = selectionAsMask()
  if (!mask || amount <= 0) return
  setSelection(null)
  applySelectionMask(dilateMask(mask, amount), 'Expand')
}

export function contractSelection(amount: number): void {
  const mask = selectionAsMask()
  if (!mask || amount <= 0) return
  setSelection(null)
  applySelectionMask(erodeMask(mask, amount), 'Contract')
}

/**
 * The Magic Wand: a flood fill from the point clicked.
 *
 * It samples the composited canvas rather than the active layer, which is Photoshop's Sample All
 * Layers behaviour and the one that matches what the pointer is pointing at. The readback is the
 * only time a frame leaves the GPU for something other than a file.
 */
export async function magicWandAt(x: number, y: number, tolerance: number, contiguous: boolean): Promise<void> {
  const target = compositor.value
  if (!target) return
  await guard(async () => {
    const flat = await target.flatten()
    if (!flat) return
    const mask = magicWandMask(flat.data, flat.width, flat.height, x, y, tolerance, contiguous)
    const chosen = selectionContains(selection.value, x, y)
    void chosen
    setSelection(maskSelection(mask))
  })
}

export function selectAll(): void {
  const current = manifest.value
  if (!current) return
  setSelection(fullSelection(current.width, current.height))
}

export function deselect(): void {
  setSelection(null)
}

export function invertSelection(): void {
  const current = selection.value
  if (!current) return
  // With a mask there is coverage to flip; a shape is inverted by flipping what it means, which
  // keeps Select All and the marquees on the cheap path.
  if (current.mask) setSelection({ ...current, mask: invertMask(current.mask) })
  else selection.value = inverted(current)
}

/** The selection a marquee drag describes. */
export function marqueeSelection(
  start: [number, number],
  end: [number, number],
  elliptical: boolean,
): Selection | null {
  const rect = rectSelection(start[0], start[1], end[0] - start[0], end[1] - start[1])
  if (!rect) return null
  return elliptical ? ellipseSelection(rect.x, rect.y, rect.width, rect.height) : rect
}

export function isSelected(x: number, y: number): boolean {
  return selectionContains(selection.value, x, y)
}

// MARK: - Moving a layer

export interface SnapResult {
  x: number
  y: number
  guidesX: number[]
  guidesY: number[]
}

/**
 * Where a dragged layer lands, with the same edges Photoshop snaps: the canvas, its centre, and
 * the other layers' edges and centres.
 *
 * `tolerance` is in document pixels and the caller divides the screen threshold by the zoom, so the
 * pull feels the same at any magnification.
 */
export function snapMove(layer: LayerRecord, x: number, y: number, tolerance: number): SnapResult {
  const current = manifest.value
  const [width, height] = layer.transform.size
  if (!current) return { x, y, guidesX: [], guidesY: [] }

  const candidatesX: number[] = [0, current.width / 2, current.width]
  const candidatesY: number[] = [0, current.height / 2, current.height]
  for (const other of current.layers) {
    if (other.id === layer.id || isFolder(other)) continue
    const [ox, oy] = other.transform.origin
    const [ow, oh] = other.transform.size
    candidatesX.push(ox, ox + ow / 2, ox + ow)
    candidatesY.push(oy, oy + oh / 2, oy + oh)
  }

  const edgesX = [x, x + width / 2, x + width]
  const edgesY = [y, y + height / 2, y + height]
  let bestX: { delta: number; line: number } | null = null
  let bestY: { delta: number; line: number } | null = null

  for (const candidate of candidatesX) {
    for (const edge of edgesX) {
      const delta = candidate - edge
      if (Math.abs(delta) <= tolerance && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) {
        bestX = { delta, line: candidate }
      }
    }
  }
  for (const candidate of candidatesY) {
    for (const edge of edgesY) {
      const delta = candidate - edge
      if (Math.abs(delta) <= tolerance && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) {
        bestY = { delta, line: candidate }
      }
    }
  }

  return {
    x: bestX ? x + bestX.delta : x,
    y: bestY ? y + bestY.delta : y,
    guidesX: bestX ? [bestX.line] : [],
    guidesY: bestY ? [bestY.line] : [],
  }
}

/** Moves a layer by a document-space offset, inside one undo step. */
export function moveLayerBy(id: string, dx: number, dy: number): void {
  applyEdit((current) => {
    const layer = current.layers.find((record) => record.id === id)
    if (!layer) return
    layer.transform.origin[0] += dx
    layer.transform.origin[1] += dy
  })
}

/** Sets a layer's origin, used once a drag finishes and the snap is known. */
export function setLayerOrigin(id: string, x: number, y: number): void {
  applyEdit((current) => {
    const layer = current.layers.find((record) => record.id === id)
    if (!layer) return
    layer.transform.origin[0] = x
    layer.transform.origin[1] = y
  })
}

// MARK: - Paint uploads

let flushScheduled = false

/**
 * Uploads the rectangles the brush touched.
 *
 * Only the changed region goes over the bus: a 4,000 × 4,000 layer costs a few hundred kilobytes
 * per dab rather than sixty-four megabytes.
 */
export function flushPaint(): void {
  const target = compositor.value
  if (!target) return
  for (const [layerId, surface] of paintStore.dirtySurfaces()) {
    const rect = surface.dirty
    if (!rect) continue
    const key = assetKey(layerId, 'image')
    const texture = target.setLayerTexture(key, surface.canvas, surface.width, surface.height, rect)
    if (texture) textures.set(key, markRaw(texture))
    layerImages.set(layerId, { width: surface.width, height: surface.height })
    paintStore.markClean(surface)
  }
}

function schedulePaintFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  requestAnimationFrame(() => {
    flushScheduled = false
    flushPaint()
  })
}

// MARK: - Import

/** Adds an imported image as a new layer on top. */
export async function addImageLayer(bitmap: ImageBitmap, name: string): Promise<void> {
  const current = manifest.value
  const target = compositor.value
  if (!current) return
  const layer = doc.createLayer({
    name,
    transform: doc.covering(bitmap.width, bitmap.height),
    hasPixels: true,
  })
  layer.transform.origin = [
    Math.round((current.width - bitmap.width) / 2),
    Math.round((current.height - bitmap.height) / 2),
  ]

  edit(`Add ${name}`, (manifestNow) => {
    doc.addLayer(manifestNow, layer)
    return true
  })
  activeLayerId.value = layer.id
  selectedIds.value = [layer.id]

  layerImages.set(layer.id, { width: bitmap.width, height: bitmap.height })
  const surface = paintStore.create(layer.id, bitmap, bitmap.width, bitmap.height)
  surface.dirty = { x: 0, y: 0, width: bitmap.width, height: bitmap.height }
  if (target) {
    const texture = target.setLayerTexture(
      assetKey(layer.id, 'image'),
      surface.canvas,
      surface.width,
      surface.height,
      surface.dirty,
    )
    if (texture) textures.set(assetKey(layer.id, 'image'), markRaw(texture))
    paintStore.markClean(surface)
  }
  bitmap.close()
}

export async function importDroppedPaths(paths: readonly string[]): Promise<void> {
  await importWhatever(async () => (await backend()).readFiles(paths))
}

/** Adds images the browser handed over directly, which is how a dropped file arrives there. */
export async function importDroppedFiles(files: readonly File[]): Promise<void> {
  await importWhatever(async () => files.map((file) => ({ name: file.name, blob: file })))
}

/** Opens a file picker and adds whatever is chosen as layers. */
export async function importImages(): Promise<void> {
  await importWhatever(async () => (await backend()).pickImages())
}

/**
 * Adds each chosen image as a layer, making a project first if none is open.
 *
 * The first image decides the canvas when there is no document, which is what Photoshop does when
 * you open a photograph with nothing else open.
 */
async function importWhatever(
  choose: () => Promise<{ name: string; blob: Blob }[]>,
): Promise<void> {
  await guard(async () => {
    const files = await choose()
    if (files.length === 0) return
    let first = true
    for (const file of files) {
      try {
        if (first && !manifest.value) {
          await newProjectFromImage(file.blob)
          first = false
        }
        const bitmap = await createImageBitmap(file.blob)
        await addImageLayer(bitmap, file.name.replace(/\.[^.]+$/, ''))
      } catch (error) {
        message.value = t('message.imageUnreadable', { name: file.name })
        console.error(error)
      }
    }
  })
}

async function newProjectFromImage(blob: Blob): Promise<void> {
  const bitmap = await createImageBitmap(blob)
  const width = bitmap.width
  const height = bitmap.height
  bitmap.close()
  const opened = await (await backend()).createProject(width, height)
  if (opened) await adopt(opened)
}

/**
 * Tells the shell to hand dropped files to the app.
 *
 * Tauri reports a drop as a list of paths rather than as browser files, because the webview is told
 * not to intercept them.
 */
export async function registerDropTarget(): Promise<void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    await getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type !== 'drop') return
      await importDroppedPaths(event.payload.paths)
    })
  } catch (error) {
    console.warn('drag and drop is unavailable', error)
  }
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
        gpuErrors.value = [...gpuErrors.value.slice(-19), text]
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
    const text = translateError(error)
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
      get tool() {
        return tool.value
      },
      get brush() {
        return brush
      },
      get foreground() {
        return foreground
      },
      get selection() {
        return selection.value
      },
      get rows() {
        return rows.value
      },
      get compositor() {
        return compositor.value
      },
      get paintSurfaces() {
        return paintStore
      },
      selectTool,
      featherSelection,
      expandSelection,
      contractSelection,
      magicWandAt,
      selectAll,
      deselect,
      invertSelection,
      get message() {
        return message.value
      },
      get selectionMaskCanvas() {
        return selectionMaskCanvas.value
      },
      get gpuErrors() {
        return gpuErrors.value
      },
      openProject,
      newProject,
      fit,
      undo,
      redo,
      flushPaint,
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
