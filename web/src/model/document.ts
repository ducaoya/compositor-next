/**
 * Document edits, as pure functions over a {@link Manifest}.
 *
 * Everything here mutates the object it is given and returns whether it changed anything. The
 * store wraps each call in a history edit, so an operation that reports `false` does not land in
 * the undo stack.
 */

import {
  COLOR_SPACE,
  CURRENT_VERSION,
  FORMAT_ID,
  type Guide,
  type LayerRecord,
  type Manifest,
  type Transform,
  indexLayers,
  isFolder,
} from './types'

/** The format writes UUIDs uppercase; the rest of the file follows that. */
export function newUuid(): string {
  return crypto.randomUUID().toUpperCase()
}

export function imageFileName(id: string): string {
  return `${id}.png`
}

export function maskFileName(id: string): string {
  return `${id}.mask.png`
}

export function covering(width: number, height: number): Transform {
  return {
    origin: [0, 0],
    size: [width, height],
    rotation: 0,
    flipX: false,
    flipY: false,
    sampling: 'High quality',
  }
}

export function createManifest(width: number, height: number): Manifest {
  return {
    format: FORMAT_ID,
    version: CURRENT_VERSION,
    colorSpace: COLOR_SPACE,
    resolution: 72,
    documentID: newUuid(),
    width,
    height,
    activeLayerID: null,
    layers: [],
    guides: [],
  }
}

export interface NewLayerOptions {
  name: string
  transform: Transform
  /**
   * Whether the layer has pixels of its own, and so needs `images/<ID>.png`.
   *
   * Defaults to `false`, matching the format: a blank layer names no image until it is painted on,
   * which is what keeps a document of empty layers from costing anything.
   */
  hasPixels?: boolean
  isGroup?: boolean
  adjustment?: unknown
  parentID?: string | null
}

export function createLayer(options: NewLayerOptions): LayerRecord {
  const id = newUuid()
  const layer: LayerRecord = {
    id,
    name: options.name,
    isVisible: true,
    transform: options.transform,
    isGroup: options.isGroup ?? false,
    opacity: 1,
    blendMode: 'Normal',
  }
  if (options.hasPixels === true && !options.isGroup) layer.imageFile = imageFileName(id)
  if (options.adjustment !== undefined) layer.adjustment = options.adjustment
  if (options.parentID) layer.parentID = options.parentID
  return layer
}

export function layerById(manifest: Manifest, id: string | null | undefined): LayerRecord | undefined {
  if (!id) return undefined
  return manifest.layers.find((layer) => layer.id === id)
}

/** A layer's siblings, in array order — bottom to top. */
export function siblings(manifest: Manifest, parentID: string | null | undefined): LayerRecord[] {
  const parent = parentID ?? null
  return manifest.layers.filter((layer) => (layer.parentID ?? null) === parent)
}

/**
 * Splits an ordered id list into whole subtrees: selecting a folder with its children and a child
 * of that folder must not move the child twice.
 */
export function topLevelSelection(manifest: Manifest, ids: readonly string[]): string[] {
  const chosen = new Set(ids)
  const byId = indexLayers(manifest)
  return ids.filter((id) => {
    let parent = byId.get(id)?.parentID ?? null
    let depth = 0
    while (parent && depth < 64) {
      if (chosen.has(parent)) return false
      parent = byId.get(parent)?.parentID ?? null
      depth += 1
    }
    return true
  })
}

export function addLayer(manifest: Manifest, layer: LayerRecord, index?: number): void {
  const at = index === undefined ? manifest.layers.length : Math.max(0, Math.min(index, manifest.layers.length))
  manifest.layers.splice(at, 0, layer)
  manifest.activeLayerID = layer.id
}

export function removeLayers(manifest: Manifest, ids: readonly string[]): boolean {
  const doomed = new Set(topLevelSelection(manifest, ids).flatMap((id) => subtreeIds(manifest, id)))
  if (doomed.size === 0) return false
  manifest.layers = manifest.layers.filter((layer) => !doomed.has(layer.id))
  // A clipping link into a deleted layer is cleared rather than left dangling: the validator
  // refuses the whole file if a source is missing.
  for (const layer of manifest.layers) {
    if (layer.maskSourceID && doomed.has(layer.maskSourceID)) delete layer.maskSourceID
  }
  if (manifest.activeLayerID && doomed.has(manifest.activeLayerID)) {
    manifest.activeLayerID = manifest.layers.at(-1)?.id ?? null
  }
  return true
}

export function subtreeIds(manifest: Manifest, id: string): string[] {
  const result = [id]
  let frontier = [id]
  let depth = 0
  while (frontier.length > 0 && depth < 64) {
    const next: string[] = []
    for (const layer of manifest.layers) {
      if (layer.parentID && frontier.includes(layer.parentID)) {
        result.push(layer.id)
        next.push(layer.id)
      }
    }
    frontier = next
    depth += 1
  }
  return result
}

/**
 * Moves one layer up or down among its siblings.
 *
 * A move that would take a clipped layer away from the base it is clipped to drops the clipping,
 * which is what Photoshop does and what the reference app does.
 */
export function moveLayer(manifest: Manifest, id: string, delta: number): boolean {
  const layer = layerById(manifest, id)
  if (!layer || delta === 0) return false
  const parent = layer.parentID ?? null
  const group = siblings(manifest, parent)
  const index = group.findIndex((sibling) => sibling.id === id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= group.length) return false

  const other = group[target]
  const a = manifest.layers.indexOf(layer)
  const b = manifest.layers.indexOf(other)
  manifest.layers[a] = other
  manifest.layers[b] = layer
  releaseBrokenClipping(manifest)
  return true
}

/** Drops clipping links whose base is no longer the immediately lower sibling. */
export function releaseBrokenClipping(manifest: Manifest): void {
  for (const layer of manifest.layers) {
    const source = layer.maskSourceID
    if (!source) continue
    const parent = layer.parentID ?? null
    const group = siblings(manifest, parent)
    const index = group.findIndex((sibling) => sibling.id === layer.id)
    const below = index > 0 ? group[index - 1] : undefined
    if (!below || (below.id !== source && below.maskSourceID !== source)) {
      delete layer.maskSourceID
    }
  }
}

export function setMaskSource(manifest: Manifest, target: string, source: string | null): boolean {
  const layer = layerById(manifest, target)
  if (!layer) return false
  if (source === null) {
    if (!layer.maskSourceID) return false
    delete layer.maskSourceID
    return true
  }
  const base = layerById(manifest, source)
  if (!base || base.id === target || isFolder(base) || base.adjustment !== undefined) return false
  if (isFolder(layer)) return false
  layer.maskSourceID = source
  return true
}

/**
 * Wraps the selection in a new folder, placed where the topmost selected layer was.
 *
 * Returns the folder's id, or `null` when the selection cannot be grouped.
 */
export function groupLayers(manifest: Manifest, ids: readonly string[]): string | null {
  const roots = topLevelSelection(manifest, ids)
  if (roots.length === 0) return null
  const chosen = roots.map((id) => layerById(manifest, id)).filter((layer): layer is LayerRecord => !!layer)
  if (chosen.length === 0) return null

  const parent = chosen[0].parentID ?? null
  const group = siblings(manifest, parent)
  const positions = chosen.map((layer) => group.indexOf(layer)).filter((index) => index >= 0)
  const topmost = Math.max(...positions)

  const bounds = unionBounds(chosen.map((layer) => layer.transform))
  const folder = createLayer({
    name: 'Folder',
    transform: bounds,
    isGroup: true,
    parentID: parent,
  })
  for (const layer of chosen) layer.parentID = folder.id

  const insertAt = manifest.layers.indexOf(group[topmost])
  manifest.layers.splice(insertAt, 0, folder)
  manifest.activeLayerID = folder.id
  return folder.id
}

export function ungroupLayers(manifest: Manifest, ids: readonly string[]): boolean {
  const folders = ids
    .map((id) => layerById(manifest, id))
    .filter((layer): layer is LayerRecord => !!layer && isFolder(layer))
  if (folders.length === 0) return false
  for (const folder of folders) {
    const parent = folder.parentID ?? null
    for (const child of manifest.layers) {
      if (child.parentID === folder.id) child.parentID = parent ?? undefined
    }
    manifest.layers = manifest.layers.filter((layer) => layer.id !== folder.id)
  }
  return true
}

/** Whether a document point falls inside a placed layer, rotation included. */
export function containsPoint(transform: Transform, x: number, y: number): boolean {
  const [ox, oy] = transform.origin
  const [width, height] = transform.size
  const cx = ox + width / 2
  const cy = oy + height / 2
  const dx = x - cx
  const dy = y - cy
  const radians = (transform.rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const localX = dx * cos + dy * sin
  const localY = -dx * sin + dy * cos
  return Math.abs(localX) <= width / 2 && Math.abs(localY) <= height / 2
}

/**
 * Moves `id` to sit where `targetId` sits among that target's siblings.
 *
 * Dropping a layer onto another one is how the panel reorders; the dragged layer takes the
target's place and keeps the target's parent, which is what makes dragging into a folder work.
 */
export function moveLayerTo(manifest: Manifest, id: string, targetId: string): boolean {
  if (id === targetId) return false
  const layer = layerById(manifest, id)
  const target = layerById(manifest, targetId)
  if (!layer || !target) return false
  // Moving a folder into its own subtree would detach it from the document.
  if (subtreeIds(manifest, id).includes(targetId)) return false

  const index = manifest.layers.indexOf(layer)
  if (index >= 0) manifest.layers.splice(index, 1)
  layer.parentID = target.parentID
  const destination = manifest.layers.indexOf(target)
  manifest.layers.splice(destination + 1, 0, layer)
  releaseBrokenClipping(manifest)
  return true
}

export function unionBounds(transforms: readonly Transform[]): Transform {
  if (transforms.length === 0) return covering(0, 0)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const transform of transforms) {
    minX = Math.min(minX, transform.origin[0])
    minY = Math.min(minY, transform.origin[1])
    maxX = Math.max(maxX, transform.origin[0] + transform.size[0])
    maxY = Math.max(maxY, transform.origin[1] + transform.size[1])
  }
  return {
    origin: [minX, minY],
    size: [Math.max(1, maxX - minX), Math.max(1, maxY - minY)],
    rotation: 0,
    flipX: false,
    flipY: false,
    sampling: 'High quality',
  }
}

export function addGuide(manifest: Manifest, axis: Guide['axis'], position: number): Guide {
  const guide: Guide = { id: newUuid(), axis, position }
  manifest.guides = [...(manifest.guides ?? []), guide]
  return guide
}

/**
 * The rules the Rust validator will apply, checked early so the UI can explain a refusal instead
 * of showing a save that silently fails. Not exhaustive: the Rust side is authoritative.
 */
export function manifestProblems(manifest: Manifest): string[] {
  const problems: string[] = []
  if (manifest.format !== FORMAT_ID) problems.push(`format must be ${FORMAT_ID}`)
  if (manifest.version < 1 || manifest.version > CURRENT_VERSION) {
    problems.push(`version ${manifest.version} is not supported`)
  }
  if (manifest.colorSpace !== COLOR_SPACE) problems.push('only sRGB projects are supported')
  if (!(manifest.width >= 1 && manifest.width <= 30_000)) problems.push('the canvas is too wide')
  if (!(manifest.height >= 1 && manifest.height <= 30_000)) problems.push('the canvas is too tall')
  if (manifest.layers.length > 10_000) problems.push('too many layers')

  const seen = new Set<string>()
  for (const layer of manifest.layers) {
    if (seen.has(layer.id)) problems.push(`two layers share the id ${layer.id}`)
    seen.add(layer.id)
    if (!layer.name.trim()) problems.push('a layer has no name')
    const opacity = layer.opacity ?? 1
    if (!(opacity >= 0 && opacity <= 1)) problems.push(`"${layer.name}" has an opacity outside 0–1`)
    if (isFolder(layer) && layer.imageFile) problems.push(`the folder "${layer.name}" holds pixels`)
    if (layer.imageFile && layer.imageFile !== imageFileName(layer.id)) {
      problems.push(`"${layer.name}" has an image file not named after it`)
    }
    if (layer.maskFile && layer.maskFile !== maskFileName(layer.id)) {
      problems.push(`"${layer.name}" has a mask file not named after it`)
    }
    if (isFolder(layer) && (layer.blendMode ?? 'Normal') !== 'Normal') {
      problems.push(`the folder "${layer.name}" has a blend mode`)
    }
  }
  if (manifest.activeLayerID && !seen.has(manifest.activeLayerID)) {
    problems.push('the active layer is not in the document')
  }
  return problems
}
