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

import { computed, markRaw, reactive, ref, shallowRef, toRaw } from 'vue'

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
  clipToSelection,
  ellipseSelection,
  fullSelection,
  inverted,
  maskSelection,
  polygonSelection,
  rectSelection,
  selectionContains,
  withMask,
  type Selection,
} from '../model/selection'
import {
  blurMask,
  combineMasks,
  createMask,
  dilateMask,
  erodeMask,
  invertMask,
  magicWandMask,
  maskBounds,
  maskFromAlpha,
  maskFromShape,
  type Mask,
  type SelectionMode,
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
import { renderEffects } from '../render/effects'
import {
  defaultEffect,
  hasEffects,
  type EffectKey,
  type LayerEffects,
} from '../model/effects'
import {
  ADJUSTMENT_KINDS,
  buildLut,
  identityAdjustment,
  type AdjustmentKind,
  type LayerAdjustment,
} from '../model/adjustments'
import {
  PaintStore,
  compositeInto,
  fillSurface,
  stampSegment,
  type BrushSettings,
  type CompositeLayer,
  type LayerSurface,
} from '../render/paint'
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
/**
 * Stops the canvas's own render loop.
 *
 * Anything that reads the frame back has to do it while nothing else is drawing: `render` reuses a
 * ping-pong pair, so a second render between the one you asked for and the readback hands you a
 * different frame. Every measurement taken through a probe before this existed was racing the
 * loop, which is why two probes of the same feature disagreed.
 */
const renderPaused = ref(false)
/** Every WebGPU diagnostic seen this session, newest last. A single `message` slot loses the first
 *  of a cascade, and the first is the one that explains the rest. */
const gpuErrors = ref<string[]>([])
const canGPU = ref(true)
const historyVersion = ref(0)

// MARK: - Open documents

/**
 * One open project.
 *
 * The state that belongs to a *document* rather than to the editor lives here, and the module-level
 * refs below hold whichever one is active. Switching tabs stashes the refs into the record and
 * reads the next record out, which is why there is exactly one place that does either — anything
 * that sets `manifest` or `view` directly would be a tab that leaks into another.
 *
 * Textures, surfaces and effect rasters stay keyed by layer UUID, which is unique across documents,
 * so they are shared and do not need stashing. Closing a tab releases its share.
 */
interface DocumentRecord {
  id: string
  /** Empty for a project that has never been saved. */
  path: string
  project: OpenedProject
  manifest: Manifest
  view: ViewState
  history: EditHistory<Manifest>
  selection: Selection | null
  maskEditing: boolean
  activeLayerId: string | null
  selectedIds: string[]
  collapsed: Set<string>
  dirty: boolean
}

/**
 * Deliberately shallow: a record holds an `EditHistory`, and deep reactivity would proxy the class
 * instance and strip what it keeps private. Records are replaced, not mutated in place, and
 * `touchDocuments` is what tells the tab bar that one changed.
 */
const documents = shallowRef<DocumentRecord[]>([])
const documentsVersion = ref(0)

function touchDocuments(): void {
  documents.value = [...documents.value]
  documentsVersion.value += 1
}
const activeDocumentId = ref<string | null>(null)

/** What a tab is called: the file's name, or a placeholder until it has one. */
export function documentName(record: DocumentRecord): string {
  if (!record.path) return 'Untitled.comp'
  return record.path.split(/[\\/]/).pop() ?? 'Untitled.comp'
}

export const documentTabs = computed(() => {
  void documentsVersion.value
  return documents.value.map((record) => ({
    id: record.id,
    name: documentName(record),
    dirty: record.dirty,
    active: record.id === activeDocumentId.value,
  }))
})

/** Writes the live refs back into the active record. */
function stashActive(): void {
  const id = activeDocumentId.value
  if (!id) return
  const record = documents.value.find((item) => item.id === id)
  if (!record) return
  if (project.value) record.project = project.value
  if (manifest.value) record.manifest = toRaw(manifest.value)
  record.view = { zoom: view.zoom, panX: view.panX, panY: view.panY }
  record.history = history
  record.selection = selection.value
  record.maskEditing = maskEditingRef.value
  record.activeLayerId = activeLayerId.value
  record.selectedIds = selectedIds.value
  record.collapsed = collapsed.value
  record.dirty = dirty.value
  touchDocuments()
}

/** Empties everything, for when the last tab closes. */
function clearDocument(): void {
  activeDocumentId.value = null
  project.value = null
  manifest.value = null
  history = newHistory()
  history.clear()
  bumpHistory()
  selection.value = null
  selectionMaskCanvas.value = null
  maskEditingRef.value = false
  activeLayerId.value = null
  selectedIds.value = []
  collapsed.value = new Set()
  dirty.value = false
  cropRect.value = null
  lassoPoints.value = []
  canRender.value = false
}

/** Reads a record out into the live refs, decoding its assets if they are not on the GPU yet. */
async function restoreDocument(record: DocumentRecord, options: { fit?: boolean } = {}): Promise<void> {
  activeDocumentId.value = record.id
  project.value = record.project
  manifest.value = record.manifest
  view.zoom = record.view.zoom
  view.panX = record.view.panX
  view.panY = record.view.panY
  history = record.history
  maskEditingRef.value = record.maskEditing
  activeLayerId.value = record.activeLayerId
  selectedIds.value = record.selectedIds
  collapsed.value = record.collapsed
  dirty.value = record.dirty
  bumpHistory()
  // Tool state that belongs to a gesture, not to a document.
  cropRect.value = null
  lassoPoints.value = []
  setSelection(record.selection)

  const target = compositor.value
  if (target) {
    target.setDocumentSize(record.manifest.width, record.manifest.height)
    await decodeAssets(record.project, target)
  }
  if (options.fit) fit()
  canRender.value = true
  await watchProject()
}

export async function activateDocument(id: string): Promise<void> {
  if (id === activeDocumentId.value) return
  const record = documents.value.find((item) => item.id === id)
  if (!record) return
  stashActive()
  await restoreDocument(record)
}

/** Frees what a closed tab was holding: its textures and its paint surfaces. */
function releaseDocument(record: DocumentRecord): void {
  const target = compositor.value
  for (const layer of record.manifest.layers) {
    for (const kind of ['image', 'mask'] as const) {
      target?.disposeLayerTexture(assetKey(layer.id, kind))
      textures.delete(assetKey(layer.id, kind))
      paintStore.dispose(layer.id, kind)
      modifiedSurfaces.delete(assetKey(layer.id, kind))
      surfaceVersion.delete(assetKey(layer.id, kind))
    }
    target?.disposeLayerTexture(`effect|${layer.id}`)
    effectRasters.delete(layer.id)
    effectTextures.delete(layer.id)
    layerImages.delete(layer.id)
  }
}

export async function closeDocument(id: string): Promise<void> {
  stashActive()
  const index = documents.value.findIndex((item) => item.id === id)
  if (index < 0) return
  releaseDocument(documents.value[index])
  documents.value = documents.value.filter((item) => item.id !== id)
  touchDocuments()
  if (activeDocumentId.value !== id) return
  const next = documents.value[index] ?? documents.value[index - 1] ?? null
  if (next) await restoreDocument(next)
  else clearDocument()
}

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
/**
/**
 * Whether the brush is painting the active layer's mask rather than its pixels.
 *
 * Photoshop tracks this per layer and changes it when the mask thumbnail is clicked; one flag is
 * enough here because only the active layer can be painted.
 */
const maskEditingRef = ref(false)
/** Surfaces whose pixels have been painted, so a save re-encodes those and nothing else. */
const modifiedSurfaces = new Set<string>()
/**
 * How many times a surface has been written, so an effects raster can tell whether the pixels it
 * was built from are still current. Coarser than it looks: only the layer that was painted on
 * changes its number, so painting does not rebuild every other layer's effects.
 */
const surfaceVersion = new Map<string, number>()
/** Effect rasters by layer, with the signature they were built from. */
const effectRasters = new Map<string, { signature: string; transform: LayerRecord['transform'] }>()
const effectTextures = new Map<string, GPUTexture>()
/**
 * Bumped whenever an effect raster is built or dropped.
 *
 * `effectTextures` is a plain map — it holds GPU handles, which must not be proxied — so nothing
 * tells the draw list that it changed. Without this the raster is built and then ignored, because
 * the computed that reads it has no reason to run again.
 */
const effectsVersion = ref(0)
/** Which effect the panel is showing, if any. */
const effectsSheetOpen = ref(false)
const effectsEditingKey = ref<EffectKey | null>(null)
/** What the user is being asked for: a feather radius, or how far to grow or shrink. */
/** The rectangle the crop tool has dragged out, before it is applied. */
const cropRect = ref<{ x: number; y: number; width: number; height: number } | null>(null)
/** The size prompt, shared by Canvas Size and Image Size, which differ only in what they do. */
export const dimensionPrompt = reactive({
  open: false,
  mode: 'canvas' as 'canvas' | 'image',
  width: 0,
  height: 0,
  anchor: 'center' as 'topLeft' | 'center' | 'centerTop',
})

export function openDimensionPrompt(mode: 'canvas' | 'image'): void {
  const current = manifest.value
  if (!current) return
  dimensionPrompt.mode = mode
  dimensionPrompt.width = current.width
  dimensionPrompt.height = current.height
  dimensionPrompt.anchor = 'center'
  dimensionPrompt.open = true
}

export function setCropRect(rect: { x: number; y: number; width: number; height: number } | null): void {
  cropRect.value = rect
}

export function applyCrop(): void {
  const rect = cropRect.value
  if (!rect) return
  cropRect.value = null
  cropTo(rect.x, rect.y, rect.width, rect.height)
}

export function cancelCrop(): void {
  cropRect.value = null
}

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
/** How a new selection joins the one already there. */
const selectionMode = ref<SelectionMode>('new')
/** Lasso: the freehand path, or a polygon built a click at a time. */
const lassoPolygonal = ref(false)
/** The polygon being built, in document coordinates. Empty when nothing is in progress. */
const lassoPoints = ref<[number, number][]>([])
/** View helpers. */
const showsRulers = ref(true)
const showsGrid = ref(false)
const gridSpacing = ref(64)
const gridSubdivisions = ref(4)
const paletteOpen = ref(false)

export function setGrid(patch: Partial<{ spacing: number; subdivisions: number }>): void {
  if (patch.spacing !== undefined) gridSpacing.value = Math.max(4, Math.round(patch.spacing))
  if (patch.subdivisions !== undefined) gridSubdivisions.value = Math.max(1, Math.round(patch.subdivisions))
}

export function addLassoPoint(x: number, y: number): void {
  lassoPoints.value = [...lassoPoints.value, [x, y]]
  if (lassoPoints.value.length >= 3) setSelection(polygonSelection(lassoPoints.value))
}

/** Closes the polygon, which is what the second click and Enter both do. */
export function closeLasso(): void {
  const points = lassoPoints.value
  lassoPoints.value = []
  if (points.length < 3) {
    setSelection(null)
    return
  }
  applySelectionMode(polygonSelection(points))
}

export function cancelLasso(): void {
  lassoPoints.value = []
  setSelection(null)
}

/** The gradient and shape tools' settings. */
const gradient = reactive({
  kind: 'linear' as 'linear' | 'radial',
  reverse: false,
  opacity: 1,
  from: 'foreground' as 'foreground' | 'background',
  to: 'background' as 'foreground' | 'background',
})
const shape = reactive({ kind: 'rectangle' as 'rectangle' | 'ellipse', filled: true, lineWidth: 8 })
const wandContiguous = ref(true)

// `structuredClone` refuses a Vue proxy, and the document is JSON by definition, so the history
// snapshots are taken the same way the format serializes them.
/**
 * `structuredClone` refuses a Vue proxy, and the document is JSON by definition, so the history
 * snapshots are taken the same way the format serializes them.
 */
function newHistory(): EditHistory<Manifest> {
  return new EditHistory<Manifest>({
    limit: 200,
    clone: ((state: Manifest) => JSON.parse(JSON.stringify(state))) as <S>(state: S) => S,
  })
}

/** The active tab's history. Every other tab keeps its own, in its record. */
let history = newHistory()
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
  // Read so a new effect raster re-runs this, and so the version is a dependency.
  void effectsVersion.value
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
    // A layer with effects draws the raster those effects were baked into: it is larger than the
    // layer, and its mask is already part of it, so neither the transform nor the mask of the
    // layer itself applies any more.
    const baked = effectTextures.get(layer.id)
    const bakedTransform = effectRasters.get(layer.id)?.transform
    result.push({
      kind: 'layer',
      id: layer.id,
      texture: baked ?? textures.get(assetKey(layer.id, 'image')) ?? null,
      mask: baked ? null : (textures.get(assetKey(layer.id, 'mask')) ?? null),
      transform: baked && bakedTransform ? bakedTransform : layer.transform,
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
    maskEditing: maskEditingRef,
    mergeTitle,
    canMergeDown,
    mergeLayers,
    mergeDown,
    copyMerged,
    exportJPEG,
    resizeCanvas,
    resizeImage,
    cropTo,
    trimTransparent,
    flipCanvas,
    editLayerMask,
    cropRect,
    dimensionPrompt,
    selectionMode,
    gradient,
    shape,
    loadLayerSelection,
    loadMaskSelection,
    drawGradient,
    drawShape,
    lassoPolygonal,
    lassoPoints,
    showsRulers,
    showsGrid,
    gridSpacing,
    gridSubdivisions,
    paletteOpen,
    renderPaused,
    setGrid,
    addLassoPoint,
    closeLasso,
    cancelLasso,
    effectsSheetOpen,
    effectsEditingKey,
    activeLayerEffects,
    openEffectsSheet,
    closeEffectsSheet,
    toggleEffect,
    patchEffect,
    setEffectEnabled,
    flushEffects,
    watchProject,
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
    // Already on the GPU, from this tab or a previous visit: uploading it again would only cost.
    if (textures.has(assetKey(asset.layerId, asset.kind))) return
    try {
      const response = await fetch(asset.url)
      const blob = await response.blob()
      const bitmap = await createImageBitmap(blob)
      const key = assetKey(asset.layerId, asset.kind)
      const texture = target.setLayerTexture(key, bitmap, bitmap.width, bitmap.height)
      textures.set(key, markRaw(texture))
      if (asset.kind === 'image') {
        layerImages.set(asset.layerId, { width: bitmap.width, height: bitmap.height })
        paintStore.create(asset.layerId, bitmap, bitmap.width, bitmap.height, 'image')
      } else {
        paintStore.create(asset.layerId, bitmap, bitmap.width, bitmap.height, 'mask')
      }
      bitmap.close()
    } catch (error) {
      console.warn(`could not decode ${asset.name}`, error)
    }
  })
  await Promise.all(jobs)
}

/**
 * Re-reads a project that changed on disk, keeping the view and the selection.
 *
 * A reload clears the undo history, exactly as reopening a file does — the states in it describe a
 * document that no longer exists. Unsaved edits win: a reload never silently discards someone's
 * work, it says so and leaves them alone.
 */
async function reloadFromDisk(): Promise<void> {
  const opened = project.value
  if (!opened?.path) return
  if (dirty.value) {
    message.value = t('message.externalChangeKept')
    return
  }
  try {
    const client = await backend()
    const fresh = await client.openProjectAt(opened.path)
    const target = compositor.value
    // Everything the old document held goes, so a layer that was deleted on disk does not linger
    // as a texture nothing refers to.
    const touched = new Set<string>([
      ...opened.manifest.layers.map((layer) => layer.id),
      ...fresh.manifest.layers.map((layer) => layer.id),
    ])
    for (const id of touched) {
      for (const kind of ['image', 'mask'] as const) {
        target?.disposeLayerTexture(assetKey(id, kind))
        textures.delete(assetKey(id, kind))
        paintStore.dispose(id, kind)
      }
      target?.disposeLayerTexture(`effect|${id}`)
      effectTextures.delete(id)
      effectRasters.delete(id)
      layerImages.delete(id)
      modifiedSurfaces.delete(assetKey(id, 'image'))
      modifiedSurfaces.delete(assetKey(id, 'mask'))
      surfaceVersion.delete(assetKey(id, 'image'))
      surfaceVersion.delete(assetKey(id, 'mask'))
    }

    const keptView = { zoom: view.zoom, panX: view.panX, panY: view.panY }
    const record = documents.value.find((item) => item.id === activeDocumentId.value)
    if (record) {
      record.project = fresh
      record.manifest = fresh.manifest
      record.dirty = false
      touchDocuments()
    }
    project.value = fresh
    manifest.value = fresh.manifest
    history.clear()
    history = record?.history ?? history
    bumpHistory()
    dirty.value = false
    if (!fresh.manifest.layers.some((layer) => layer.id === activeLayerId.value)) {
      activeLayerId.value = fresh.manifest.activeLayerID ?? fresh.manifest.layers.at(-1)?.id ?? null
      selectedIds.value = activeLayerId.value ? [activeLayerId.value] : []
    }
    view.zoom = keptView.zoom
    view.panX = keptView.panX
    view.panY = keptView.panY
    target?.setDocumentSize(fresh.manifest.width, fresh.manifest.height)
    if (target) await decodeAssets(fresh, target)
    effectsVersion.value += 1
    message.value = t('message.reloaded')
  } catch (error) {
    message.value = translateError(error)
  }
}

let reloadTimer: ReturnType<typeof setTimeout> | null = null

/** A save touches a dozen files; one reload per dozen events is what this is for. */
function scheduleReload(): void {
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    void reloadFromDisk()
  }, 300)
}

let watchBound = false

/**
 * Asks the shell to watch the open project, and listens for what it reports.
 *
 * A `.comp` is a folder of files precisely so that other things can write it, and this is what
 * makes that visible: an agent, a sync client or a git checkout changes the project and the canvas
 * redraws.
 */
async function watchProject(): Promise<void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  const opened = project.value
  if (!opened?.path) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    if (!watchBound) {
      watchBound = true
      const { listen } = await import('@tauri-apps/api/event')
      await listen('project:changed', () => scheduleReload())
    }
    await invoke('watch_project', { id: opened.path, path: opened.path, enabled: true })
  } catch (error) {
    // A project that cannot be watched still opens; it just will not notice outside changes.
    console.warn('this project cannot be watched', error)
  }
}

/**
 * Opens a project, in a new tab or in the one that already has it.
 *
 * Opening the same file twice would give two tabs writing to one package, so a path that is
 * already open is activated instead.
 */
async function adopt(opened: OpenedProject): Promise<void> {
  stashActive()
  if (opened.path) {
    const existing = documents.value.find((item) => item.path === opened.path)
    if (existing) {
      await restoreDocument(existing)
      return
    }
  }
  pendingBytes = new Map()
  const record: DocumentRecord = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    path: opened.path,
    project: opened,
    manifest: opened.manifest,
    view: { zoom: 1, panX: 0, panY: 0 },
    history: newHistory(),
    selection: null,
    maskEditing: false,
    activeLayerId: opened.manifest.activeLayerID ?? opened.manifest.layers.at(-1)?.id ?? null,
    selectedIds: [],
    collapsed: new Set(),
    dirty: false,
  }
  documents.value = [...documents.value, record]
  touchDocuments()
  canRender.value = true
  await restoreDocument(record, { fit: true })
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
    // Anything the brush touched is re-encoded here; everything else is linked from the file it
    // already has, which is what keeps saving a large document cheap.
    for (const surfaceId of modifiedSurfaces) {
      const [layerId, surfaceKind] = surfaceId.split('|')
      const bytes = await paintStore.encode(layerId, surfaceKind === 'mask' ? 'mask' : 'image')
      if (bytes) pendingBytes.set(surfaceId, bytes)
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

/** Which of a layer's two surfaces the tools are working on. */
export function paintTarget(): import('../render/paint').SurfaceKind {
  const layer = activeLayer.value
  return maskEditing.value && layer?.maskFile ? 'mask' : 'image'
}

export function setMaskEditing(on: boolean): void {
  maskEditing.value = on
}

const maskEditing = maskEditingRef
export const maskEditingState = maskEditingRef

/** The surface for a layer, made from its pixels if it does not have one yet. */
export function ensureSurface(layer: LayerRecord, kind: import('../render/paint').SurfaceKind): LayerSurface {
  const { width, height } = layerPixelSize(layer)
  return paintStore.ensure(layer.id, width, height, kind)
}

// MARK: - Painting

let strokeLayer: string | null = null
let strokeKind: import('../render/paint').SurfaceKind = 'image'
/** Where the last stroke ended, in document coordinates, for a Shift-click's straight line. */
let lastStrokeEnd: [number, number] | null = null
let strokeLast: [number, number] | null = null
let strokeSmoothed: [number, number] | null = null

/** Alt on a brush turns it into the other one, as Photoshop's Option/Alt does. */
function brushErasing(): boolean {
  return tool.value === 'eraser'
}

export function beginStroke(x: number, y: number, extendFromLast = false): void {
  const layer = paintableLayer()
  if (!layer) return
  const kind = paintTarget()
  const surface = ensureSurface(layer, kind)
  const clip = currentSelectionClip(layer)
  const [lx, ly] = documentToLayer(layer, x, y)
  const radius = (brush.size / 2) / layerPixelScale(layer)

  history.begin(kind === 'mask' ? 'Paint Mask' : 'Brush', manifest.value!)
  // A layer that had no pixels now has some, which is what makes it save.
  if (kind === 'image' && !layer.imageFile) layer.imageFile = doc.imageFileName(layer.id)
  if (kind === 'image') layerImages.set(layer.id, { width: surface.width, height: surface.height })
  modifiedSurfaces.add(assetKey(layer.id, kind))

  strokeLayer = layer.id
  strokeKind = kind
  // Shift continues from where the last stroke left off, as a straight line.
  if (extendFromLast && lastStrokeEnd) {
    const [fromX, fromY] = documentToLayer(layer, lastStrokeEnd[0], lastStrokeEnd[1])
    surface.dirty = unionDirty(surface.dirty, stampSegment(surface, [fromX, fromY], [lx, ly], radius, brush, brushErasing(), clip))
    strokeLast = [lx, ly]
  }
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
  const surface = paintStore.surface(strokeLayer, strokeKind)
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
  // Kept in document coordinates so it survives a change of layer or zoom.
  if (strokeLast && strokeLayer) {
    const layer = manifest.value?.layers.find((record) => record.id === strokeLayer)
    if (layer) {
      const matrix = layerMatrix(layer)
      const point = matrix.transformPoint(new DOMPoint(strokeLast[0], strokeLast[1]))
      lastStrokeEnd = [point.x, point.y]
    }
  }
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
  const kind = paintTarget()
  const surface = ensureSurface(layer, kind)
  edit(kind === 'mask' ? 'Fill Mask' : color ? 'Fill' : 'Clear', (current) => {
    const record = current.layers.find((item) => item.id === layer.id)
    if (!record) return false
    if (kind === 'image' && !record.imageFile) record.imageFile = doc.imageFileName(record.id)
    if (kind === 'image') layerImages.set(record.id, { width: surface.width, height: surface.height })
    fillSurface(surface, color, currentSelectionClip(record))
    return true
  })
  modifiedSurfaces.add(assetKey(layer.id, kind))
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

/**
 * Adds a layer mask, white, which is Photoshop's "Reveal All".
 *
 * The mask is document-sized when the layer is, and matches the layer's own pixels otherwise, so
 * the same transform places both.
 */
export function addLayerMask(): void {
  const layer = paintableLayer()
  if (!layer || layer.maskFile) return
  const size = layerPixelSize(layer)
  edit('Add Layer Mask', (current) => {
    const record = current.layers.find((item) => item.id === layer.id)
    if (!record) return false
    record.maskFile = doc.maskFileName(record.id)
    record.maskEnabled = true
    return true
  })
  maskEditing.value = true
  const surface = paintStore.ensure(layer.id, size.width, size.height, 'mask')
  surface.dirty = { x: 0, y: 0, width: surface.width, height: surface.height }
  modifiedSurfaces.add(assetKey(layer.id, 'mask'))
  schedulePaintFlush()
}

export function removeLayerMask(): void {
  const layer = paintableLayer()
  if (!layer?.maskFile) return
  edit('Delete Layer Mask', (current) => {
    const record = current.layers.find((item) => item.id === layer.id)
    if (!record) return false
    delete record.maskFile
    delete record.maskEnabled
    return true
  })
  paintStore.dispose(layer.id, 'mask')
  textures.delete(assetKey(layer.id, 'mask'))
  modifiedSurfaces.delete(assetKey(layer.id, 'mask'))
  maskEditing.value = false
}

export function toggleMaskEnabled(): void {
  const layer = paintableLayer()
  if (!layer?.maskFile) return
  edit('Mask', (current) => {
    const record = current.layers.find((item) => item.id === layer.id)
    if (!record) return false
    record.maskEnabled = record.maskEnabled === false
    return true
  })
}

// MARK: - Loading a selection from what is already there

/**
 * Select -> Layer's Pixels: the layer's own alpha, thresholded.
 *
 * Thresholded rather than soft because a selection is a selection: a pixel is in it or it is not,
 * and a layer with a soft edge should not make a selection with a soft edge by accident. Feather
 * is the tool for that.
 */
export function loadLayerSelection(): void {
  const layer = paintableLayer()
  const current = manifest.value
  if (!layer || !current) return
  const surface = paintStore.surface(layer.id, 'image')
  if (!surface) return
  const image = surface.context.getImageData(0, 0, surface.width, surface.height)
  const mask = createMask(current.width, current.height)
  const matrix = layerMatrix(layer)
  const inverse = matrix.inverse()
  // Walk the layer's own pixels and mark the document pixels they cover, so a scaled or rotated
  // layer selects where it actually is rather than where its rectangle is.
  for (let y = 0; y < surface.height; y += 1) {
    for (let x = 0; x < surface.width; x += 1) {
      if (image.data[(y * surface.width + x) * 4 + 3] < 128) continue
      const point = matrix.transformPoint(new DOMPoint(x + 0.5, y + 0.5))
      const px = Math.floor(point.x)
      const py = Math.floor(point.y)
      if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) continue
      mask.data[py * mask.width + px] = 255
    }
  }
  void inverse
  if (maskBounds(mask) === null) {
    message.value = t('message.selectionEmpty')
    return
  }
  setSelection(maskSelection(mask))
}

/** Select -> Mask's Black Areas: the mask, as coverage. */
export function loadMaskSelection(): void {
  const layer = activeLayer.value
  if (!layer?.maskFile) return
  const surface = paintStore.surface(layer.id, 'mask')
  if (!surface) return
  const image = surface.context.getImageData(0, 0, surface.width, surface.height)
  setSelection(maskSelection(maskFromAlpha(image.data, surface.width, surface.height, 1)))
}

// MARK: - Gradients and shapes

/**
 * Paints a gradient along the line dragged.
 *
 * Drawn with the canvas's own gradient, which interpolates in sRGB between two stops — the same
 * thing Photoshop does, and the same thing the compositor does for `CILinearGradient` in the
 * original.
 */
export function drawGradient(from: [number, number], to: [number, number]): void {
  const layer = paintableLayer()
  if (!layer) return
  const surface = ensureSurface(layer, paintTarget())
  const clip = currentSelectionClip(layer)
  const start = documentToLayer(layer, from[0], from[1])
  const end = documentToLayer(layer, to[0], to[1])
  const first = gradient.from === 'foreground' ? { ...foreground } : { ...background }
  const second = gradient.reverse
    ? gradient.to === 'foreground'
      ? { ...foreground }
      : { ...background }
    : gradient.to === 'foreground'
      ? { ...foreground }
      : { ...background }

  history.begin('Gradient', manifest.value!)
  const context = surface.context
  context.save()
  if (clip?.maskCanvas) {
    // A masked selection needs the gradient cut down before it lands, as the brush does.
    const scratch = new OffscreenCanvas(surface.width, surface.height)
    const scratchContext = scratch.getContext('2d')
    if (scratchContext) {
      paintGradient(scratchContext, start, end, first, second, gradient.kind)
      scratchContext.globalCompositeOperation = 'destination-in'
      scratchContext.setTransform(clip.documentToLayer ?? new DOMMatrix())
      scratchContext.drawImage(clip.maskCanvas, 0, 0)
      context.globalAlpha = gradient.opacity
      context.drawImage(scratch, 0, 0)
    }
  } else {
    context.globalAlpha = gradient.opacity
    clipToSelection(context, clip?.selection ?? null, manifest.value!.width, manifest.value!.height)
    paintGradient(context, start, end, first, second, gradient.kind)
  }
  context.restore()
  surface.dirty = { x: 0, y: 0, width: surface.width, height: surface.height }
  modifiedSurfaces.add(assetKey(layer.id, paintTarget()))
  if (paintTarget() === 'image' && !layer.imageFile) layer.imageFile = doc.imageFileName(layer.id)
  endEdit()
  schedulePaintFlush()
}

function paintGradient(
  context: OffscreenCanvasRenderingContext2D,
  start: [number, number],
  end: [number, number],
  first: { r: number; g: number; b: number },
  second: { r: number; g: number; b: number },
  kind: 'linear' | 'radial',
): void {
  const css = (colour: { r: number; g: number; b: number }) => `rgb(${colour.r},${colour.g},${colour.b})`
  const shade =
    kind === 'linear'
      ? context.createLinearGradient(start[0], start[1], end[0], end[1])
      : context.createRadialGradient(start[0], start[1], 0, start[0], start[1], Math.hypot(end[0] - start[0], end[1] - start[1]))
  shade.addColorStop(0, css(first))
  shade.addColorStop(1, css(second))
  context.fillStyle = shade
  context.fillRect(0, 0, context.canvas.width, context.canvas.height)
}

/** Draws a rectangle or an ellipse between the corners dragged. */
export function drawShape(from: [number, number], to: [number, number], filled: boolean): void {
  const layer = paintableLayer()
  if (!layer) return
  const surface = ensureSurface(layer, paintTarget())
  const clip = currentSelectionClip(layer)
  const a = documentToLayer(layer, from[0], from[1])
  const b = documentToLayer(layer, to[0], to[1])
  const scale = layerPixelScale(layer)
  const width = Math.abs(b[0] - a[0])
  const height = Math.abs(b[1] - a[1])
  if (width < 1 || height < 1) return

  history.begin('Shape', manifest.value!)
  const context = surface.context
  context.save()
  applyClipForFill(context, clip)
  context.fillStyle = `rgb(${foreground.r},${foreground.g},${foreground.b})`
  context.strokeStyle = `rgb(${foreground.r},${foreground.g},${foreground.b})`
  context.lineWidth = Math.max(1, shape.lineWidth * scale)
  context.beginPath()
  if (shape.kind === 'rectangle') {
    context.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), width, height)
  } else {
    context.ellipse(
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2,
      width / 2,
      height / 2,
      0,
      0,
      Math.PI * 2,
    )
  }
  if (filled) context.fill()
  else context.stroke()
  context.restore()
  surface.dirty = { x: 0, y: 0, width: surface.width, height: surface.height }
  modifiedSurfaces.add(assetKey(layer.id, paintTarget()))
  if (paintTarget() === 'image' && !layer.imageFile) layer.imageFile = doc.imageFileName(layer.id)
  endEdit()
  schedulePaintFlush()
}

/** The clip for a whole-surface fill: a shape clips by path, a coverage mask by compositing. */
function applyClipForFill(
  context: OffscreenCanvasRenderingContext2D,
  clip: import('../render/paint').SelectionClip | null,
): void {
  if (clip?.maskCanvas) return
  if (clip) clipToSelection(context, clip.selection, clip.canvasWidth, clip.canvasHeight)
}

/** The effects on a layer, typed. The manifest keeps them as opaque JSON. */
function layerEffects(layer: LayerRecord): LayerEffects | null {
  return (layer.effects as LayerEffects | undefined) ?? null
}

/** Whether the active layer has anything the Effects panel should open for. */
export const activeLayerEffects = computed<LayerEffects | null>(() => {
  const layer = activeLayer.value
  return layer ? layerEffects(layer) : null
})

export function openEffectsSheet(): void {
  if (!activeLayer.value) return
  const effects = layerEffects(activeLayer.value)
  effectsEditingKey.value = effects && hasEffects(effects)
    ? (Object.keys(effects).find((key) => (effects as Record<string, unknown>)[key]) as EffectKey | undefined) ?? null
    : null
  effectsSheetOpen.value = true
}

export function closeEffectsSheet(): void {
  effectsSheetOpen.value = false
}

/** Turns one effect on with its defaults, or off and gone. */
export function toggleEffect(key: EffectKey): void {
  const layer = activeLayer.value
  if (!layer) return
  edit(`Layer Effects`, (current) => {
    const record = current.layers.find((item) => item.id === layer.id)
    if (!record) return false
    const effects: LayerEffects = { ...((record.effects as LayerEffects | undefined) ?? {}) }
    if (effects[key]) delete effects[key]
    else effects[key] = defaultEffect(key) as never
    record.effects = Object.keys(effects).length > 0 ? effects : undefined
    return true
  })
  const effects = layerEffects(activeLayer.value ?? layer)
  effectsEditingKey.value = effects?.[key] ? key : null
}

/** Merges a change into one effect. A drag wraps this in beginEdit/endEdit. */
export function patchEffect(key: EffectKey, patch: Record<string, unknown>): void {
  const layer = activeLayer.value
  if (!layer) return
  const record = manifest.value?.layers.find((item) => item.id === layer.id)
  if (!record) return
  const effects: LayerEffects = { ...((record.effects as LayerEffects | undefined) ?? {}) }
  const existing = (effects[key] as Record<string, unknown> | undefined) ?? {}
  effects[key] = { ...existing, ...patch } as never
  record.effects = effects
}

export function setEffectEnabled(key: EffectKey, enabled: boolean): void {
  beginEdit('Layer Effects')
  patchEffect(key, { enabled })
  endEdit()
}

// MARK: - Compositing on the CPU

/**
 * The surfaces and placements a CPU composite needs, for the layers named.
 *
 * Only the layers that have pixels and a surface take part: a folder and an adjustment layer draw
 * nothing of their own, though an adjustment's effect on what is below it cannot be reproduced
 * here and is not attempted.
 */
function compositeLayersFor(ids: readonly string[]): CompositeLayer[] {
  const current = manifest.value
  if (!current) return []
  const byId = indexLayers(current)
  const out: CompositeLayer[] = []
  for (const id of ids) {
    const layer = byId.get(id)
    if (!layer || isFolder(layer)) continue
    const surface = paintStore.surface(id, 'image')
    if (!surface) continue
    out.push({
      surface,
      transform: layer.transform,
      opacity: effectiveOpacity(layer, byId),
      blendMode: blendModeOf(layer),
      mask: paintStore.surface(id, 'mask') ?? null,
    })
  }
  return out
}

/** The visible leaf layers, bottom to top, in the order the canvas draws them. */
function visibleLayerIds(): string[] {
  const current = manifest.value
  if (!current) return []
  return visibleLeaves(current.layers)
    .filter((layer) => !isFolder(layer) && layer.adjustment === undefined)
    .map((layer) => layer.id)
}

/** The document flattened on the CPU, for the operations that need pixels and have no GPU. */
function flattenOnCpu(): OffscreenCanvas | null {
  const current = manifest.value
  if (!current) return null
  const canvas = new OffscreenCanvas(current.width, current.height)
  compositeInto(canvas, compositeLayersFor(visibleLayerIds()))
  return canvas
}

function surfaceFromCanvas(layerId: string, canvas: OffscreenCanvas): LayerSurface | null {
  const context = canvas.getContext('2d')
  if (!context) return null
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  const target = new OffscreenCanvas(canvas.width, canvas.height)
  const targetContext = target.getContext('2d')
  if (!targetContext) return null
  targetContext.putImageData(image, 0, 0)
  paintStore.dispose(layerId, 'image')
  return paintStore.createFromCanvas(layerId, target)
}

// MARK: - Merging

/**
 * Merges the selected layers into the topmost of them, or the active layer down onto the one below.
 *
 * The result is document-sized, which is what Photoshop produces too: a merged layer's bounds are
 * the canvas, not the union of what went into it.
 */
function mergeInto(ids: readonly string[], name: string, label: string): void {
  const current = manifest.value
  if (!current || ids.length < 2) return
  const byId = indexLayers(current)
  const ordered = current.layers.filter((layer) => ids.includes(layer.id))
  const top = ordered[ordered.length - 1]

  const canvas = new OffscreenCanvas(current.width, current.height)
  compositeInto(canvas, compositeLayersFor(ordered.map((layer) => layer.id)))

  edit(label, (manifestNow) => {
    const record = manifestNow.layers.find((item) => item.id === top.id)
    if (!record) return false
    // A merged layer keeps the top layer's identity so the stack position, mask and name survive.
    record.transform = doc.covering(manifestNow.width, manifestNow.height)
    record.imageFile = doc.imageFileName(record.id)
    record.blendMode = 'Normal'
    record.opacity = 1
    delete record.maskSourceID
    const doomed = new Set(ordered.slice(0, -1).map((layer) => layer.id))
    manifestNow.layers = manifestNow.layers.filter((layer) => !doomed.has(layer.id))
    for (const layer of manifestNow.layers) {
      if (layer.maskSourceID && doomed.has(layer.maskSourceID)) delete layer.maskSourceID
    }
    return true
  })

  const surface = surfaceFromCanvas(top.id, canvas)
  if (surface) {
    surface.dirty = { x: 0, y: 0, width: surface.width, height: surface.height }
  }
  layerImages.set(top.id, { width: canvas.width, height: canvas.height })
  modifiedSurfaces.add(assetKey(top.id, 'image'))
  activeLayerId.value = top.id
  selectedIds.value = [top.id]
  schedulePaintFlush()
  void byId
  void name
}

export function mergeLayers(): void {
  const ids = targetIds()
  if (ids.length < 2) return
  const top = manifest.value?.layers.filter((layer) => ids.includes(layer.id)).at(-1)
  mergeInto(doc.topLevelSelection(manifest.value!, ids), top?.name ?? 'Merged', 'Merge Layers')
}

export function mergeDown(): void {
  const current = manifest.value
  const active = activeLayer.value
  if (!current || !active || isFolder(active)) return
  const parent = active.parentID ?? null
  const siblings = current.layers.filter((layer) => (layer.parentID ?? null) === parent)
  const at = siblings.findIndex((layer) => layer.id === active.id)
  if (at <= 0) return
  const below = siblings[at - 1]
  if (isFolder(below)) return
  mergeInto([below.id, active.id], active.name, 'Merge Down')
}

export const canMergeDown = computed(() => {
  const current = manifest.value
  const active = activeLayer.value
  if (!current || !active || isFolder(active)) return false
  const parent = active.parentID ?? null
  const siblings = current.layers.filter((layer) => (layer.parentID ?? null) === parent)
  const at = siblings.findIndex((layer) => layer.id === active.id)
  return at > 0 && !isFolder(siblings[at - 1])
})

export const mergeTitle = computed(() => {
  const count = targetIds().length
  return count > 1 ? `Merge ${count} Layers` : 'Merge Down'
})

// MARK: - Copy Merged

/** Puts the flattened document on the clipboard, as a picture. */
export async function copyMerged(): Promise<void> {
  await guard(async () => {
    const canvas = flattenOnCpu()
    if (!canvas) return
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    message.value = t('message.copied')
  })
}

// MARK: - Exporting JPEG

export async function exportJPEG(quality = 0.9): Promise<void> {
  const target = compositor.value
  if (!target) return
  await guard(async () => {
    const flat = await target.flatten()
    if (!flat) return
    const canvas = document.createElement('canvas')
    canvas.width = flat.width
    canvas.height = flat.height
    const context = canvas.getContext('2d')
    if (!context) return
    // JPEG has no alpha, so the flattened image is laid on white first.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.putImageData(new ImageData(new Uint8ClampedArray(flat.data), flat.width, flat.height), 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (!blob) return
    await (await backend()).exportFile(`${documentBaseName()}.jpg`, blob)
  })
}

function documentBaseName(): string {
  const path = project.value?.path
  if (!path) return 'composite'
  return (path.split(/[\\/]/).pop() ?? 'composite').replace(/\.comp$/i, '')
}

// MARK: - Canvas Size, Image Size, Trim and Crop

/** Resamples a surface to a new size, in place. */
function resampleSurface(surface: LayerSurface, width: number, height: number): void {
  if (surface.width === width && surface.height === height) return
  const source = surface.canvas
  surface.canvas.width = Math.max(1, width)
  surface.canvas.height = Math.max(1, height)
  const context = surface.canvas.getContext('2d')
  if (!context) return
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, surface.width, surface.height)
  surface.width = surface.canvas.width
  surface.height = surface.canvas.height
}

/** Changes the canvas size, moving everything by the difference and keeping the anchors asked for. */
export function resizeCanvas(width: number, height: number, anchor: 'topLeft' | 'center' | 'centerTop' = 'center'): void {
  const current = manifest.value
  if (!current) return
  const dx = anchor === 'topLeft' ? 0 : Math.round((width - current.width) / 2)
  const dy = anchor === 'center' ? Math.round((height - current.height) / 2) : anchor === 'centerTop' ? 0 : 0

  edit('Canvas Size', (manifestNow) => {
    if (manifestNow.width === width && manifestNow.height === height && dx === 0 && dy === 0) return false
    manifestNow.width = width
    manifestNow.height = height
    for (const layer of manifestNow.layers) {
      layer.transform.origin[0] += dx
      layer.transform.origin[1] += dy
      // A mask placed on its own moves with the canvas; a linked one follows its layer and has
      // already moved.
      if (layer.maskPlacement) {
        layer.maskPlacement.origin[0] += dx
        layer.maskPlacement.origin[1] += dy
      }
    }
    for (const guide of manifestNow.guides ?? []) {
      guide.position += guide.axis === 'vertical' ? dx : dy
    }
    return true
  })
  compositor.value?.setDocumentSize(width, height)
  clearSelection()
  fit()
}

/** Scales the whole document, pixels and all. */
export function resizeImage(width: number, height: number): void {
  const current = manifest.value
  if (!current || width < 1 || height < 1) return
  const scaleX = width / current.width
  const scaleY = height / current.height

  for (const layer of current.layers) {
    layer.transform.origin[0] *= scaleX
    layer.transform.origin[1] *= scaleY
    layer.transform.size[0] *= scaleX
    layer.transform.size[1] *= scaleY
  }

  for (const [surfaceId, surface] of paintStore.allSurfaces()) {
    const [layerId] = surfaceId.split('|')
    const layer = current.layers.find((item) => item.id === layerId)
    if (!layer) continue
    const nextWidth = Math.max(1, Math.round(surface.width * scaleX))
    const nextHeight = Math.max(1, Math.round(surface.height * scaleY))
    resampleSurface(surface, nextWidth, nextHeight)
    if (!surfaceId.endsWith('|mask')) layerImages.set(layerId, { width: surface.width, height: surface.height })
    surface.dirty = { x: 0, y: 0, width: surface.width, height: surface.height }
    modifiedSurfaces.add(surfaceId)
  }

  edit('Image Size', (manifestNow) => {
    manifestNow.width = width
    manifestNow.height = height
    return true
  })
  resizeCanvasPixels(width, height)
  schedulePaintFlush()
  fit()
}

function resizeCanvasPixels(width: number, height: number): void {
  compositor.value?.setDocumentSize(width, height)
  clearSelection()
}

/** Crops to the rectangle, in document coordinates. */
export function cropTo(x: number, y: number, width: number, height: number): void {
  const current = manifest.value
  if (!current || width < 1 || height < 1) return
  const left = Math.round(x)
  const top = Math.round(y)
  const w = Math.round(width)
  const h = Math.round(height)

  edit('Crop', (manifestNow) => {
    manifestNow.width = w
    manifestNow.height = h
    for (const layer of manifestNow.layers) {
      layer.transform.origin[0] -= left
      layer.transform.origin[1] -= top
      if (layer.maskPlacement) {
        layer.maskPlacement.origin[0] -= left
        layer.maskPlacement.origin[1] -= top
      }
    }
    for (const guide of manifestNow.guides ?? []) {
      guide.position -= guide.axis === 'vertical' ? left : top
    }
    return true
  })
  resizeCanvasPixels(w, h)
  fit()
}

/** Crops away the transparent border: Photoshop's Trim. */
export function trimTransparent(): boolean {
  const current = manifest.value
  const canvas = flattenOnCpu()
  if (!current || !canvas) return false
  const context = canvas.getContext('2d')
  if (!context) return false
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height)
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return false
  cropTo(minX, minY, maxX - minX + 1, maxY - minY + 1)
  return true
}

// MARK: - Flipping the canvas

export function flipCanvas(horizontally: boolean): void {
  const current = manifest.value
  if (!current) return
  edit('Flip Canvas', (manifestNow) => {
    for (const layer of manifestNow.layers) {
      const transform = layer.transform
      transform.flipX = horizontally ? !transform.flipX : transform.flipX
      transform.flipY = horizontally ? transform.flipY : !transform.flipY
      const [ox, oy] = transform.origin
      const [w, h] = transform.size
      if (horizontally) transform.origin[0] = manifestNow.width - ox - w
      else transform.origin[1] = manifestNow.height - oy - h
    }
    return true
  })
}

// MARK: - Mask operations

function maskSurface(layerId: string): LayerSurface | null {
  return paintStore.surface(layerId, 'mask') ?? null
}

/** Reads a mask surface as coverage. */
function surfaceAsMask(surface: LayerSurface): Mask {
  const image = surface.context.getImageData(0, 0, surface.width, surface.height)
  const mask: Mask = { width: surface.width, height: surface.height, data: new Uint8Array(surface.width * surface.height) }
  for (let index = 0; index < mask.data.length; index += 1) mask.data[index] = image.data[index * 4]
  return mask
}

function writeMaskSurface(surface: LayerSurface, mask: Mask): void {
  const image = surface.context.createImageData(mask.width, mask.height)
  for (let index = 0; index < mask.data.length; index += 1) {
    image.data[index * 4] = mask.data[index]
    image.data[index * 4 + 1] = mask.data[index]
    image.data[index * 4 + 2] = mask.data[index]
    image.data[index * 4 + 3] = 255
  }
  surface.context.putImageData(image, 0, 0)
  surface.dirty = { x: 0, y: 0, width: surface.width, height: surface.height }
}

/** Invert, blur or feather a layer's mask, in one undo step. */
export function editLayerMask(action: 'invert' | 'blur' | 'feather', amount = 5): void {
  const layer = paintableLayer()
  if (!layer?.maskFile) return
  const surface = maskSurface(layer.id)
  if (!surface) return
  const label = action === 'invert' ? 'Invert Mask' : action === 'blur' ? 'Blur Mask' : 'Feather Mask'
  edit(label, () => {
    const mask = surfaceAsMask(surface)
    writeMaskSurface(surface, action === 'invert' ? invertMask(mask) : blurMask(mask, amount / 2))
    return true
  })
  modifiedSurfaces.add(assetKey(layer.id, 'mask'))
  schedulePaintFlush()
}

// MARK: - Selections

/**
 * Replaces the selection, and rebuilds the coverage canvas the brush and the fill read.
 *
 * Every path that changes the selection comes through here, which is why combining modes and
 * keeping the canvas in step are one thing rather than two.
 */
export function setSelection(next: Selection | null): void {
  selection.value = next
  selectionMaskCanvas.value = next?.mask ? maskToCanvas(next.mask) : null
}

/**
 * Adds a freshly drawn selection to the one already there, in the current mode.
 *
 * A shape is rasterised first, because combining coverage is the only operation that means
 * anything across the four modes — "subtract" has no meaning for two rectangles without one.
 */
export function applySelectionMode(next: Selection | null): void {
  const mode = selectionMode.value
  const manifestNow = manifest.value
  if (!manifestNow) {
    setSelection(next)
    return
  }
  if (mode === 'new') {
    setSelection(next)
    return
  }
  if (!next) return
  const incoming = next.mask ?? maskFromShapeOf(next, manifestNow.width, manifestNow.height)
  const base = selection.value?.mask ?? (selection.value ? maskFromShapeOf(selection.value, manifestNow.width, manifestNow.height) : null)
  setSelection(maskSelection(combineMasks(base, incoming, mode)))
}

function maskFromShapeOf(shape: Selection, width: number, height: number): Mask {
  const kind = shape.kind === 'mask' ? 'rectangle' : shape.kind
  const mask = maskFromShape(
    { kind, bounds: { x: shape.x, y: shape.y, width: shape.width, height: shape.height }, points: shape.points },
    width,
    height,
  )
  return shape.inverted ? invertMask(mask) : mask
}

/** Select -> All, then the coverage canvas follows. */
export function selectAllMasK(): void {
  selectAll()
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

function clearSelection(): void {
  setSelection(null)
}

export function selectAll(): void {
  const current = manifest.value
  if (!current) return
  setSelection(fullSelection(current.width, current.height))
  selectionMaskCanvas.value = null
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

/** Moves the active layer by whole pixels; the arrow keys in Photoshop's amount. */
export function nudgeActive(dx: number, dy: number): void {
  const id = activeLayerId.value
  if (!id) return
  edit('Nudge Layer', (current) => {
    const layer = current.layers.find((record) => record.id === id)
    if (!layer) return false
    layer.transform.origin[0] += dx
    layer.transform.origin[1] += dy
    return true
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
  for (const [surfaceId, surface] of paintStore.dirtySurfaces()) {
    const rect = surface.dirty
    if (!rect) continue
    const [layerId, surfaceKind] = surfaceId.split('|')
    const key = assetKey(layerId, surfaceKind === 'mask' ? 'mask' : 'image')
    const texture = target.setLayerTexture(key, surface.canvas, surface.width, surface.height, rect)
    if (texture) textures.set(key, markRaw(texture))
    if (surfaceKind !== 'mask') layerImages.set(layerId, { width: surface.width, height: surface.height })
    surfaceVersion.set(surfaceId, (surfaceVersion.get(surfaceId) ?? 0) + 1)
    paintStore.markClean(surface)
  }
  flushEffects()
}

/**
 * Rebuilds the effect rasters whose layer or effects have changed, and uploads them.
 *
 * Called every frame, so the common case is a signature comparison and nothing else: a raster is
 * only redrawn when the effect settings or the pixels underneath them moved.
 */
export function flushEffects(): void {
  const target = compositor.value
  const current = manifest.value
  if (!target || !current) return
  const wanted = new Set<string>()

  for (const layer of visibleLeaves(current.layers)) {
    if (isFolder(layer)) continue
    const effects = layerEffects(layer)
    if (!hasEffects(effects)) continue
    const surface = paintStore.surface(layer.id, 'image')
    if (!surface) continue
    wanted.add(layer.id)
    const signature = [
      JSON.stringify(effects),
      `${surface.width}x${surface.height}`,
      surfaceVersion.get(assetKey(layer.id, 'image')) ?? 0,
      surfaceVersion.get(assetKey(layer.id, 'mask')) ?? 0,
    ].join('|')
    const cached = effectRasters.get(layer.id)
    if (cached?.signature === signature) continue

    const rendered = renderEffects(surface, paintStore.surface(layer.id, 'mask') ?? null, effects!, layer.transform)
    if (!rendered) continue
    const key = `effect|${layer.id}`
    const texture = target.setLayerTexture(key, rendered.canvas, rendered.canvas.width, rendered.canvas.height)
    effectTextures.set(layer.id, markRaw(texture))
    effectRasters.set(layer.id, { signature, transform: rendered.transform })
    effectsVersion.value += 1
  }

  for (const id of [...effectRasters.keys()]) {
    if (wanted.has(id)) continue
    effectRasters.delete(id)
    effectTextures.delete(id)
    target.disposeLayerTexture(`effect|${id}`)
    effectsVersion.value += 1
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
      setForeground,
      nudgeActive,
      get lassoPoints() {
        return lassoPoints.value
      },
      loadLayerSelection,
      loadMaskSelection,
      drawShape,
      drawGradient,
      mergeDown,
      mergeLayers,
      resizeCanvas,
      resizeImage,
      cropTo,
      trimTransparent,
      flipCanvas,
      editLayerMask,
      applyCrop,
      addLayerMask,
      removeLayerMask,
      setMaskEditing,
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
      reloadFromDisk,
      watchProject,
      addAdjustment,
      renderAndRead,
      pauseRender,
      resumeRender,
      get renderPaused() {
        return renderPaused.value
      },
    },
    configurable: true,
  })
}

export function pauseRender(): void {
  renderPaused.value = true
}

export function resumeRender(): void {
  renderPaused.value = false
}

/**
 * Renders the current document and reads the frame back, with nothing else drawing.
 *
 * The one supported way to inspect pixels. It pauses the loop, flushes whatever the brush left
 * pending, renders, and reads — in that order, with nothing able to happen in between.
 */
export async function renderAndRead(): Promise<{ width: number; height: number; data: number[] } | null> {
  const target = compositor.value
  if (!target) return null
  pauseRender()
  try {
    flushPaint()
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
    target.render(draws.value, { zoom: view.zoom * dpr, panX: view.panX * dpr, panY: view.panY * dpr })
    const frame = await target.flatten()
    if (!frame) return null
    return { width: frame.width, height: frame.height, data: Array.from(frame.data) }
  } finally {
    resumeRender()
  }
}

/** Marks an asset as rewritten, so a save writes bytes rather than copying the old file. */
export function markAssetBytes(key: string, bytes: Uint8Array): void {
  pendingBytes.set(key, bytes)
}

export function assetBytes(): AssetBytes {
  return pendingBytes
}
