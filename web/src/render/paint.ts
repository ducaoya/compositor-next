/**
 * Painting, on the CPU, one canvas per layer.
 *
 * Photoshop keeps a layer's pixels in a raster it can draw into, and uploads to the GPU. This does
 * the same: an `OffscreenCanvas` per layer holds the truth, the brush stamps into it with ordinary
 * 2D drawing, and only the rectangle a stroke touched is re-uploaded. Painting straight into the
 * GPU texture would mean implementing brush tips, blending and undo against the GPU for no gain —
 * the dabs are cheap either way, and this way a stroke is exactly what `CanvasRenderingContext2D`
 * says it is.
 *
 * Coordinates here are always **layer pixels**, never document pixels. The caller maps.
 */

import { clipToSelection, type Selection } from '../model/selection'
import { encodeGrayscalePng, grayscaleFromRgba } from './png'

export interface BrushSettings {
  /** Diameter in document pixels, 1–500. */
  size: number
  /** 0 is a fully soft edge, 1 a hard one. */
  hardness: number
  /** 0–1. */
  opacity: number
  /** 0–1, where 1 paints solid along the whole stroke. */
  flow: number
  /** sRGB 0–255. */
  color: { r: number; g: number; b: number }
}

export interface DirtyRect {
  x: number
  y: number
  width: number
  height: number
}

export interface LayerSurface {
  canvas: OffscreenCanvas
  context: OffscreenCanvasRenderingContext2D
  width: number
  height: number
  /** Layer pixels changed since the last upload, or null when the GPU copy is current. */
  dirty: DirtyRect | null
}

/** The smallest rectangle covering both, with `b` optional. */
export function unionRect(a: DirtyRect | null, b: DirtyRect | null): DirtyRect | null {
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

/** Clamps to the surface and rounds outwards, so a dab's soft edge is never clipped. */
export function clampRect(rect: DirtyRect, width: number, height: number): DirtyRect | null {
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  const right = Math.min(width, Math.ceil(rect.x + rect.width))
  const bottom = Math.min(height, Math.ceil(rect.y + rect.height))
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

/** What a surface holds: a layer's pixels, or its mask. */
export type SurfaceKind = 'image' | 'mask'

const surfaceKey = (layerId: string, kind: SurfaceKind) => `${layerId}|${kind}`

export class PaintStore {
  private surfaces = new Map<string, LayerSurface>()

  surface(layerId: string, kind: SurfaceKind = 'image'): LayerSurface | undefined {
    return this.surfaces.get(surfaceKey(layerId, kind))
  }

  has(layerId: string, kind: SurfaceKind = 'image'): boolean {
    return this.surfaces.has(surfaceKey(layerId, kind))
  }

  /**
   * Makes a surface, seeded from its pixels when it has any.
   *
   * A mask surface is seeded from a gray bitmap and filled white when there is none, which is
   * Photoshop's "Reveal All" default: the mask starts by hiding nothing.
   */
  create(
    layerId: string,
    source: ImageBitmap | null,
    width: number,
    height: number,
    kind: SurfaceKind = 'image',
  ): LayerSurface {
    const key = surfaceKey(layerId, kind)
    const existing = this.surfaces.get(key)
    if (existing && existing.width === width && existing.height === height) return existing

    const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('a 2D context was not available for painting')
    if (source) context.drawImage(source, 0, 0)
    else if (kind === 'mask') context.fillStyle = '#ffffff'
    if (!source && kind === 'mask') context.fillRect(0, 0, canvas.width, canvas.height)
    const surface: LayerSurface = { canvas, context, width, height, dirty: null }
    this.surfaces.set(key, surface)
    return surface
  }

  /** The surface for a layer, made empty if the layer has no pixels yet. */
  ensure(layerId: string, width: number, height: number, kind: SurfaceKind = 'image'): LayerSurface {
    return this.surfaces.get(surfaceKey(layerId, kind)) ?? this.create(layerId, null, width, height, kind)
  }

  dispose(layerId: string, kind: SurfaceKind = 'image'): void {
    this.surfaces.delete(surfaceKey(layerId, kind))
  }

  clear(): void {
    this.surfaces.clear()
  }

  /** Every surface whose pixels have changed since it was last uploaded, with its key. */
  dirtySurfaces(): [string, LayerSurface][] {
    return [...this.surfaces].filter(([, surface]) => surface.dirty !== null)
  }

  markClean(surface: LayerSurface): void {
    surface.dirty = null
  }

  /**
   * Encodes a layer's pixels, or its mask, as the PNG the format wants.
   *
   * Pixels go through the canvas, which writes RGBA. A mask has to be 8-bit grayscale with no
   * alpha, which the canvas cannot write, so it is encoded here instead.
   */
  async encode(layerId: string, kind: SurfaceKind = 'image'): Promise<Uint8Array | null> {
    const surface = this.surfaces.get(surfaceKey(layerId, kind))
    if (!surface) return null
    if (kind === 'image') {
      const blob = await surface.canvas.convertToBlob({ type: 'image/png' })
      return new Uint8Array(await blob.arrayBuffer())
    }
    const image = surface.context.getImageData(0, 0, surface.width, surface.height)
    return encodeGrayscalePng(surface.width, surface.height, grayscaleFromRgba(image.data, surface.width * surface.height))
  }
}

// MARK: - Brush

/** The radius a dab grows by before it starts fading: hardness 1 keeps a one-pixel feather. */
function hardnessInner(radius: number, hardness: number): number {
  return radius * Math.min(Math.max(hardness, 0), 0.999)
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/**
 * How a dab is limited to the selection.
 *
 * The selection lives in document coordinates and the surface in the layer's own pixels, so the
 * two are bridged by a matrix rather than by converting the shape — which keeps an ellipse an
 * ellipse and a rotated layer correct.
 */
export interface SelectionClip {
  selection: Selection
  canvasWidth: number
  canvasHeight: number
  /** Maps layer pixels to document pixels. */
  layerToDocument: DOMMatrix
  /**
   * The selection as coverage, when it is not a shape.
   *
   * A canvas clip takes a path, and coverage is not a path. Such a selection is applied by
   * compositing the tip through the mask instead: draw the tip on a scratch, keep only what the
   * mask covers, then put the result on the layer.
   */
  maskCanvas?: OffscreenCanvas | null
  /** Maps document pixels to layer pixels, for placing the mask under the tip. */
  documentToLayer?: DOMMatrix
}

/** Grown as needed and reused: a brush stamp is the hottest allocation in the app. */
let scratch: OffscreenCanvas | null = null
let scratchContext: OffscreenCanvasRenderingContext2D | null = null

function scratchFor(size: number): OffscreenCanvasRenderingContext2D | null {
  const side = Math.max(4, Math.ceil(size))
  if (!scratch || scratch.width < side || scratch.height < side) {
    scratch = new OffscreenCanvas(side, side)
    scratchContext = scratch.getContext('2d')
  }
  if (!scratchContext) return null
  scratchContext.setTransform(new DOMMatrix())
  scratchContext.globalCompositeOperation = 'source-over'
  scratchContext.globalAlpha = 1
  scratchContext.clearRect(0, 0, side, side)
  return scratchContext
}

/**
 * One dab, limited to a coverage-mask selection.
 *
 * The tip is drawn on the shared scratch and cut down by the mask, then composited. Erasing goes
 * through the same path with `destination-out`, so a soft selection erases softly.
 */
function stampThroughMask(
  surface: LayerSurface,
  x: number,
  y: number,
  radius: number,
  settings: BrushSettings,
  erasing: boolean,
  clip: SelectionClip,
  alpha: number,
): DirtyRect | null {
  const diameter = Math.ceil(radius * 2) + 2
  const scratchCtx = scratchFor(diameter)
  if (!scratch || !scratchCtx || !clip.maskCanvas) return null

  const local = radius + 1
  const gradient = scratchCtx.createRadialGradient(
    local,
    local,
    hardnessInner(radius, settings.hardness),
    local,
    local,
    radius,
  )
  const { r, g, b } = settings.color
  gradient.addColorStop(0, erasing ? 'rgba(0,0,0,1)' : `rgba(${r},${g},${b},1)`)
  gradient.addColorStop(1, erasing ? 'rgba(0,0,0,0)' : `rgba(${r},${g},${b},0)`)
  scratchCtx.fillStyle = gradient
  scratchCtx.beginPath()
  scratchCtx.arc(local, local, radius, 0, Math.PI * 2)
  scratchCtx.fill()

  // Keep only what the selection covers. The mask is in document space and this context is in
  // layer pixels, so the tip is placed through the same mapping the mask is drawn through.
  scratchCtx.globalCompositeOperation = 'destination-in'
  const toLayer = clip.documentToLayer ?? new DOMMatrix()
  const origin = toLayer.transformPoint(new DOMPoint(x - local, y - local))
  scratchCtx.setTransform(toLayer)
  scratchCtx.translate(origin.x, origin.y)
  scratchCtx.drawImage(clip.maskCanvas, 0, 0)
  scratchCtx.setTransform(new DOMMatrix())

  const context = surface.context
  context.save()
  context.globalAlpha = alpha
  context.globalCompositeOperation = erasing ? 'destination-out' : 'source-over'
  context.drawImage(scratch, x - local, y - local, diameter, diameter)
  context.restore()

  return { x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 }
}

function applyClip(
  context: OffscreenCanvasRenderingContext2D,
  clip: SelectionClip | null,
): void {
  if (!clip) return
  context.setTransform(clip.layerToDocument)
  clipToSelection(context, clip.selection, clip.canvasWidth, clip.canvasHeight)
  // Back to layer pixels: a clip is recorded in device space, so this does not move it.
  context.setTransform(new DOMMatrix())
}

/**
 * Stamps one dab.
 *
 * Photoshop's brush is a radial falloff: opaque out to `hardness`, then fading to transparent at
 * the rim. `flow` is how opaque each dab is, which is why overlapping dabs along a slow drag build
 * up — the same two-stage model Photoshop uses.
 */
export function stampDab(
  surface: LayerSurface,
  x: number,
  y: number,
  radius: number,
  settings: BrushSettings,
  erasing: boolean,
  clip: SelectionClip | null,
): DirtyRect | null {
  if (radius <= 0.05) return null
  const alpha = clamp01(settings.flow * settings.opacity)
  if (alpha <= 0) return null

  if (clip?.maskCanvas) return stampThroughMask(surface, x, y, radius, settings, erasing, clip, alpha)

  const context = surface.context
  context.save()
  applyClip(context, clip)
  context.globalAlpha = alpha
  context.globalCompositeOperation = erasing ? 'destination-out' : 'source-over'

  const { r, g, b } = settings.color
  const gradient = context.createRadialGradient(
    x,
    y,
    hardnessInner(radius, settings.hardness),
    x,
    y,
    radius,
  )
  gradient.addColorStop(0, erasing ? 'rgba(0,0,0,1)' : `rgba(${r},${g},${b},1)`)
  gradient.addColorStop(1, erasing ? 'rgba(0,0,0,0)' : `rgba(${r},${g},${b},0)`)

  context.fillStyle = gradient
  context.beginPath()
  context.arc(x, y, radius, 0, Math.PI * 2)
  context.fill()
  context.restore()

  return { x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 }
}

/** Stamps dabs along a segment, so a fast drag does not leave gaps. */
export function stampSegment(
  surface: LayerSurface,
  from: [number, number],
  to: [number, number],
  radius: number,
  settings: BrushSettings,
  erasing: boolean,
  clip: SelectionClip | null,
): DirtyRect | null {
  const distance = Math.hypot(to[0] - from[0], to[1] - from[1])
  // Photoshop's default spacing is 25% of the tip.
  const spacing = Math.max(0.5, radius * 0.25)
  const steps = Math.max(1, Math.ceil(distance / spacing))
  let dirty: DirtyRect | null = null
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    const x = from[0] + (to[0] - from[0]) * t
    const y = from[1] + (to[1] - from[1]) * t
    dirty = unionRect(dirty, stampDab(surface, x, y, radius, settings, erasing, clip))
  }
  return dirty
}

/** Floods the whole layer with a colour, or clears it, limited to the selection. */
export function fillSurface(
  surface: LayerSurface,
  color: { r: number; g: number; b: number } | null,
  clip: SelectionClip | null,
): DirtyRect {
  const context = surface.context
  const toLayer = clip?.maskCanvas ? (clip.documentToLayer ?? new DOMMatrix()) : null

  if (clip?.maskCanvas && toLayer) {
    context.save()
    if (color) {
      // The colour goes on a scratch, the mask cuts it down, and what is left is laid on top.
      const painted = new OffscreenCanvas(surface.width, surface.height)
      const paintedContext = painted.getContext('2d')
      if (paintedContext) {
        paintedContext.fillStyle = `rgb(${color.r},${color.g},${color.b})`
        paintedContext.fillRect(0, 0, surface.width, surface.height)
        paintedContext.globalCompositeOperation = 'destination-in'
        paintedContext.setTransform(toLayer)
        paintedContext.drawImage(clip.maskCanvas, 0, 0)
      }
      context.globalCompositeOperation = 'source-over'
      context.drawImage(painted, 0, 0)
    } else {
      // Erasing by the mask's own alpha clears exactly the coverage, soft edges included.
      context.globalCompositeOperation = 'destination-out'
      context.setTransform(toLayer)
      context.drawImage(clip.maskCanvas, 0, 0)
    }
    context.restore()
    return { x: 0, y: 0, width: surface.width, height: surface.height }
  }

  context.save()
  applyClip(context, clip)
  context.globalCompositeOperation = color ? 'source-over' : 'destination-out'
  if (color) context.fillStyle = `rgb(${color.r},${color.g},${color.b})`
  context.fillRect(0, 0, surface.width, surface.height)
  context.restore()
  return { x: 0, y: 0, width: surface.width, height: surface.height }
}
