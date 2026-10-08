/**
 * The document model, typed against the `.comp` manifest.
 *
 * A record keeps an index signature so fields this build does not model yet — `adjustment`,
 * `effects`, `text`, `shape` — survive a load/save cycle untouched. The Rust side does the same,
 * and together they mean a project written by a newer build is not silently stripped.
 */

export const FORMAT_ID = 'com.compositor.project'
export const CURRENT_VERSION = 11
export const MIN_VERSION = 1
export const COLOR_SPACE = 'sRGB'

/** Every blend mode the format holds, spelled exactly as the format spells them. */
export const BLEND_MODES = [
  'Normal',
  'Darken',
  'Multiply',
  'Color Burn',
  'Linear Burn',
  'Lighten',
  'Screen',
  'Color Dodge',
  'Linear Dodge (Add)',
  'Overlay',
  'Soft Light',
  'Hard Light',
  'Vivid Light',
  'Linear Light',
  'Pin Light',
  'Hard Mix',
  'Difference',
  'Exclusion',
  'Subtract',
  'Divide',
  'Hue',
  'Saturation',
  'Color',
  'Luminosity',
] as const

export type BlendModeName = (typeof BLEND_MODES)[number]

/** Photoshop's grouping, used to draw separators in the mode picker. */
export const BLEND_MODE_GROUPS: readonly (readonly BlendModeName[])[] = [
  ['Normal'],
  ['Darken', 'Multiply', 'Color Burn', 'Linear Burn'],
  ['Lighten', 'Screen', 'Color Dodge', 'Linear Dodge (Add)'],
  ['Overlay', 'Soft Light', 'Hard Light', 'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix'],
  ['Difference', 'Exclusion', 'Subtract', 'Divide'],
  ['Hue', 'Saturation', 'Color', 'Luminosity'],
]

export const SAMPLINGS = ['Nearest', 'Smooth', 'High quality'] as const
export type Sampling = (typeof SAMPLINGS)[number]

export type PointTuple = [number, number]

export interface Transform {
  /** Top-left corner in document pixels. */
  origin: PointTuple
  /** Placed width and height. The image is stretched to this, so a layer can be a cut-out. */
  size: PointTuple
  rotation: number
  flipX: boolean
  flipY: boolean
  sampling: Sampling
}

export interface Guide {
  id: string
  axis: 'horizontal' | 'vertical'
  position: number
}

export interface LayerRecord {
  id: string
  name: string
  isVisible: boolean
  transform: Transform
  imageFile?: string
  parentID?: string | null
  isGroup?: boolean | null
  opacity?: number | null
  blendMode?: BlendModeName | null
  maskFile?: string | null
  maskEnabled?: boolean | null
  maskSourceID?: string | null
  maskPlacement?: Transform | null
  maskLinked?: boolean | null
  /** Kept verbatim; this build does not render adjustments yet. */
  adjustment?: unknown
  shape?: unknown
  effects?: unknown
  text?: unknown
  [key: string]: unknown
}

export interface Manifest {
  format: string
  version: number
  colorSpace: string
  resolution?: number | null
  documentID: string
  width: number
  height: number
  activeLayerID?: string | null
  layers: LayerRecord[]
  guides?: Guide[] | null
  [key: string]: unknown
}

/**
 * Limits the app enforces. The Rust side resolves these from the machine's memory and the UI reads
 * them back, so there is one source of truth rather than two copies of a number.
 */
export interface AppLimits {
  maxSide: number
  maxSurfacePixels: number
  maxLayers: number
  documentPixelBudget: number
  currentVersion: number
  supportedVersions: [number, number]
}

/** What the app uses when it is running in a browser and cannot ask Rust. */
export const DEFAULT_LIMITS: AppLimits = {
  maxSide: 30_000,
  maxSurfacePixels: 200_000_000,
  maxLayers: 10_000,
  documentPixelBudget: 200_000_000,
  currentVersion: CURRENT_VERSION,
  supportedVersions: [MIN_VERSION, CURRENT_VERSION],
}

export function isFolder(layer: LayerRecord): boolean {
  return layer.isGroup === true
}

/** The opacity a layer is drawn at: its own, multiplied by every folder above it. */
export function effectiveOpacity(layer: LayerRecord, byId: Map<string, LayerRecord>): number {
  let opacity = layer.opacity ?? 1
  let parent = layer.parentID ?? null
  let depth = 0
  while (parent && depth < 64) {
    const folder = byId.get(parent)
    if (!folder) break
    opacity *= folder.opacity ?? 1
    parent = folder.parentID ?? null
    depth += 1
  }
  return opacity
}

export function blendModeOf(layer: LayerRecord): BlendModeName {
  return layer.blendMode ?? 'Normal'
}

export function indexLayers(manifest: Manifest): Map<string, LayerRecord> {
  return new Map(manifest.layers.map((layer) => [layer.id, layer]))
}

/**
 * The layers as the canvas draws them: a depth-first walk of the folder tree, bottom to top.
 *
 * Mirrors the reference app's `LayerHierarchy.entries`, including its tolerance for a child
 * appearing before its parent in the array — siblings are grouped by `parentID` and keep their
 * array order, they do not have to be contiguous.
 */
export interface HierarchyEntry {
  layer: LayerRecord
  depth: number
  /** Whether the layer and every folder above it is visible. */
  visible: boolean
}

export function hierarchyEntries(
  layers: readonly LayerRecord[],
  options: { topFirst?: boolean; collapsed?: ReadonlySet<string> } = {},
): HierarchyEntry[] {
  const children = new Map<string | null, LayerRecord[]>()
  for (const layer of layers) {
    const key = layer.parentID ?? null
    const bucket = children.get(key)
    if (bucket) bucket.push(layer)
    else children.set(key, [layer])
  }

  const result: HierarchyEntry[] = []
  const visit = (parent: string | null, depth: number, visible: boolean) => {
    if (depth > 64) return
    const siblings = children.get(parent) ?? []
    const ordered = options.topFirst ? [...siblings].reverse() : siblings
    for (const layer of ordered) {
      const effective = visible && layer.isVisible !== false
      result.push({ layer, depth, visible: effective })
      if (isFolder(layer) && !options.collapsed?.has(layer.id)) {
        visit(layer.id, depth + 1, effective)
      }
    }
  }
  visit(null, 0, true)
  return result
}

/** The layers that take part in compositing, bottom to top. */
export function visibleLeaves(layers: readonly LayerRecord[]): LayerRecord[] {
  return hierarchyEntries(layers)
    .filter((entry) => entry.visible && !isFolder(entry.layer))
    .map((entry) => entry.layer)
}
