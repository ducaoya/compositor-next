/**
 * The retouch strokes: Clone Stamp, the smooth group, the tone group, and Spot Healing.
 *
 * These tools differ from the brush in one way that decides everything here: they rework the pixels
 * already on the layer rather than stamping a colour. So each stroke takes a **sample** when it
 * starts and every dab writes a result computed from that sample — a clone copies the sample from
 * an offset, a blur paints the sample through a Gaussian, a smudge drags a patch of it along. Take
 * the sample per dab instead and a clone would copy its own output, painting a blur of itself down
 * the stroke; take it per stroke and the stroke behaves the way the reference does.
 *
 * The kernels are pure functions over typed arrays in `render/retouch/`; this file is the state
 * machine around them — where the sample lives, how the tip limits a dab, and how far apart the
 * dabs go. Also, "retouch" rather than "paint" in the names, so the two are not confused at the
 * call site.
 *
 * Coordinates are **layer pixels** throughout. The caller maps from document pixels.
 */

import {
  blurred,
  contentFill,
  dodgeBurn,
  sharpened,
  smudgeDab,
  smudgePickUp,
  sponge as spongePixel,
  spotHeal,
  toneWeight,
  type Rgba,
  type SmudgeCarry,
  type ToneRange,
} from './retouch'
import { clampRect, unionRect, type DirtyRect, type LayerSurface } from './paint'

/** Which retouch stroke this is. One per tool, with Spot Healing a mode of its own. */
export type RetouchKind = 'clone' | 'blur' | 'sharpen' | 'smudge' | 'dodge' | 'burn' | 'sponge' | 'heal'

export interface RetouchOptions {
  kind: RetouchKind
  /** Half the brush's size, in layer pixels. */
  radius: number
  /** 0 is a fully soft edge, 1 a hard one. */
  hardness: number
  /** 0–1. How much of each dab's result is laid down. */
  strength: number
  /** Clone: how far the source sits from the paint point, in layer pixels. */
  offset: [number, number]
  /** Blur and Sharpen: the Gaussian's sigma, in layer pixels. */
  sigma: number
  /** Blur and Sharpen: the unsharp amount, which is 1 for a plain blur. */
  amount: number
  /** Dodge, Burn and Sponge. */
  toneRange: ToneRange
  /** Dodge, Burn and Sponge: 0–1 per dab, from the options bar's Exposure. */
  exposure: number
  /** Sponge only: towards full saturation, or towards none. */
  saturating: boolean
  /** Spot Healing: 0 content-aware, 1 create texture, 2 proximity match. */
  healMode: 0 | 1 | 2
  /** Spot Healing's grain, so the same stroke heals the same way twice. */
  seed: number
}

/** How far apart a dab's centre goes, as a fraction of the tip's diameter. */
function spacing(radius: number, kind: RetouchKind): number {
  // A smudge is a drag, not a stamp: dabs a pixel or so apart run together into one smear, while
  // the reference's 2.5% for the others is Photoshop's own default spacing.
  return Math.max(0.5, radius * (kind === 'smudge' ? 0.02 : 0.5))
}

/**
 * How much of a dab reaches a point `distance` from its centre.
 *
 * The brush's own falloff: solid out to `hardness`, then a smoothstep to nothing at the rim.
 * Clone, blur, sharpen and the tone group all paint through it; the smudge kernel has its own copy
 * because its falloff has to match the reference's exactly, and the heal's coverage is this one.
 */
function tipWeight(distance: number, radius: number, hardness: number): number {
  if (radius <= 0) return 0
  const u = distance / radius
  if (u >= 1) return 0
  const inner = Math.min(Math.max(hardness, 0), 0.999)
  if (u <= inner) return 1
  const t = (1 - u) / (1 - inner)
  return t * t * (3 - 2 * t)
}

/**
 * One retouch stroke in progress.
 *
 * Holds the sample, the tip's own scratch canvas, and — for a smudge or a heal — a working copy of
 * the layer's pixels that the dabs mutate. `dab` is called as the pointer moves and works out its
 * own spacing, so a fast drag has no gaps, exactly as `stampSegment` does for the brush.
 */
export class RetouchStroke {
  private readonly surface: LayerSurface
  private readonly options: RetouchOptions
  private readonly radius: number
  private readonly step: number
  /** The layer's pixels as they were when the stroke began, as a canvas a dab can composite. */
  private sampleCanvas: OffscreenCanvas | null = null
  /** The scratch the tip is cut out on, reused for every dab. */
  private scratch: OffscreenCanvas
  private scratchContext: OffscreenCanvasRenderingContext2D
  /** A smudge or heal dab's working pixels, read once and written back a rectangle at a time. */
  private working: ImageData | null = null
  private carry: SmudgeCarry | null = null
  /** Spot Healing's coverage, accumulated over the whole stroke and healed at the end. */
  private coverage: Uint8ClampedArray | null = null
  private covered = false
  private last: [number, number] | null = null
  private touched: DirtyRect | null = null

  constructor(surface: LayerSurface, options: RetouchOptions) {
    this.surface = surface
    this.options = options
    this.radius = Math.max(0.5, options.radius)
    this.step = spacing(this.radius, options.kind)

    const side = Math.ceil(this.radius * 2) + 4
    this.scratch = new OffscreenCanvas(side, side)
    const context = this.scratch.getContext('2d')
    if (!context) throw new Error('a 2D context was not available for retouching')
    this.scratchContext = context

    if (options.kind === 'clone' || options.kind === 'blur' || options.kind === 'sharpen') {
      const image = surface.context.getImageData(0, 0, surface.width, surface.height)
      let sampled: Rgba = { data: image.data, width: surface.width, height: surface.height }
      if (options.kind === 'blur') {
        sampled = blurred(sampled, options.sigma)
      } else if (options.kind === 'sharpen') {
        sampled = sharpened(sampled, options.sigma, options.amount)
      }
      const canvas = new OffscreenCanvas(surface.width, surface.height)
      const canvasContext = canvas.getContext('2d')
      if (canvasContext) {
        // Copy the typed array: `putImageData` reads it at call time, and the sample must keep the
        // values the stroke started with while the layer underneath changes.
        canvasContext.putImageData(
          new ImageData(new Uint8ClampedArray(sampled.data), surface.width, surface.height),
          0,
          0,
        )
      }
      this.sampleCanvas = canvas
    }

    if (options.kind === 'smudge' || options.kind === 'heal') {
      this.working = surface.context.getImageData(0, 0, surface.width, surface.height)
      if (options.kind === 'heal') this.coverage = new Uint8ClampedArray(surface.width * surface.height)
    }
  }

  /** The whole stroke's work, for the caller's undo step and upload. */
  get dirty(): DirtyRect | null {
    return this.touched
  }

  /** Whether any dab painted anything, so a stray click with no source can be a no-op. */
  get painted(): boolean {
    return this.covered
  }

  /** Moves the stroke to a point, dabbing along the way. */
  to(point: [number, number]): void {
    const from = this.last
    this.last = point
    if (!from) {
      // A smudge's first point is a pick-up, not a dab: there is nothing carried yet, so this is
      // where the patch it will drag the length of the stroke comes from.
      if (this.options.kind === 'smudge' && this.working) {
        this.carry = smudgePickUp(this.working, point, Math.ceil(this.radius))
        return
      }
      this.dab(point)
      return
    }
    const distance = Math.hypot(point[0] - from[0], point[1] - from[1])
    if (distance < this.step) return
    const steps = Math.ceil(distance / this.step)
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps
      this.dab([from[0] + (point[0] - from[0]) * t, from[1] + (point[1] - from[1]) * t])
    }
  }

  /**
   * The end of the stroke.
   *
   * Only Spot Healing has anything to do here: it accumulates coverage as the stroke is drawn and
   * heals once, because the heal looks at the image around the whole stroke, and healing dab by dab
   * would have each dab looking at what the last one invented.
   */
  finish(): DirtyRect | null {
    const kind = this.options.kind
    if (kind !== 'heal' || !this.working || !this.coverage) return this.touched
    if (!this.covered) return this.touched
    const healed = spotHeal(this.working, this.coverage, this.options.strength, this.options.healMode, this.options.seed)
    if (!healed) return this.touched
    const bounds = coverageRect(this.coverage, this.surface.width, this.surface.height)
    if (!bounds) return this.touched
    this.surface.context.putImageData(this.working, 0, 0, bounds.x, bounds.y, bounds.width, bounds.height)
    this.touched = unionRect(this.touched, bounds)
    return this.touched
  }

  private dab(point: [number, number]): void {
    switch (this.options.kind) {
      case 'clone':
      case 'blur':
      case 'sharpen':
        this.dabSample(point)
        return
      case 'smudge':
        this.dabSmudge(point)
        return
      case 'dodge':
      case 'burn':
      case 'sponge':
        this.dabTone(point)
        return
      case 'heal':
        this.dabHeal(point)
    }
  }

  /**
   * One dab of the sample-composited kinds: the sample is placed so the pixel the dab copies lands
   * under the tip's centre, the tip cuts it down, and what is left is laid on the layer.
   *
   * `destination-in` with the tip on the scratch is the same shape the brush uses for a
   * coverage-mask selection, and for the same reason: a radial gradient is a gradient, not a path,
   * and cutting one with the other is what a canvas is good at.
   */
  private dabSample(point: [number, number]): void {
    const canvas = this.sampleCanvas
    if (!canvas) return
    const side = this.scratch.width
    const local = side / 2
    const context = this.scratchContext
    context.setTransform(new DOMMatrix())
    context.globalCompositeOperation = 'source-over'
    context.clearRect(0, 0, side, side)
    // The sample's pixel under the tip's centre is the one at `point + offset`, so the canvas goes
    // down at the negative of that plus where the centre sits on the scratch.
    const [offsetX, offsetY] = this.options.offset
    context.drawImage(canvas, local - point[0] - offsetX, local - point[1] - offsetY)

    const gradient = context.createRadialGradient(
      local,
      local,
      this.radius * Math.min(Math.max(this.options.hardness, 0), 0.999),
      local,
      local,
      this.radius,
    )
    const alpha = Math.min(1, Math.max(0, this.options.strength))
    gradient.addColorStop(0, `rgba(0,0,0,${alpha})`)
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    context.globalCompositeOperation = 'destination-in'
    context.fillStyle = gradient
    context.beginPath()
    context.arc(local, local, this.radius, 0, Math.PI * 2)
    context.fill()

    const target = this.surface.context
    target.save()
    target.setTransform(new DOMMatrix())
    target.globalCompositeOperation = 'source-over'
    target.drawImage(this.scratch, point[0] - local, point[1] - local)
    target.restore()
    this.mark({ x: point[0] - this.radius, y: point[1] - this.radius, width: this.radius * 2, height: this.radius * 2 })
  }

  private dabSmudge(point: [number, number]): void {
    const working = this.working
    const carry = this.carry
    if (!working || !carry) return
    smudgeDab(working, carry, point, this.radius, this.options.hardness, this.options.strength)
    const rect = clampRect(
      { x: point[0] - this.radius, y: point[1] - this.radius, width: this.radius * 2, height: this.radius * 2 },
      this.surface.width,
      this.surface.height,
    )
    if (!rect) return
    this.surface.context.putImageData(working, 0, 0, rect.x, rect.y, rect.width, rect.height)
    this.mark(rect)
  }

  /**
   * One dab of the tone group.
   *
   * Read, adjust and write back, rather than compositing a sample, because these two build up: the
   * second pass over an area has to see what the first one did, which is what makes a dodge
   * brighten a shadow it has already passed over.
   */
  private dabTone(point: [number, number]): void {
    const radius = Math.ceil(this.radius) + 1
    const rect = clampRect(
      { x: point[0] - radius, y: point[1] - radius, width: radius * 2, height: radius * 2 },
      this.surface.width,
      this.surface.height,
    )
    if (!rect) return
    const image = this.surface.context.getImageData(rect.x, rect.y, rect.width, rect.height)
    const exposure = Math.min(1, Math.max(0, this.options.exposure))
    const saturating = this.options.saturating
    for (let y = 0; y < rect.height; y += 1) {
      for (let x = 0; x < rect.width; x += 1) {
        const pixel = (y * rect.width + x) * 4
        const distance = Math.hypot(rect.x + x + 0.5 - point[0], rect.y + y + 0.5 - point[1])
        const falloff = tipWeight(distance, this.radius, this.options.hardness)
        if (falloff <= 0) continue
        const rgb: [number, number, number] = [
          image.data[pixel] / 255,
          image.data[pixel + 1] / 255,
          image.data[pixel + 2] / 255,
        ]
        if (this.options.kind === 'sponge') {
          const moved = spongePixel(rgb, falloff, exposure, saturating)
          for (let channel = 0; channel < 3; channel += 1) {
            image.data[pixel + channel] = Math.round(moved[channel] * 255)
          }
          continue
        }
        // Photoshop's Range picks which tones the brush reaches at all, and the tone is the
        // pixel's own luminance, so a dodge set to Highlights passes over a shadow.
        const tone = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
        const reach = falloff * toneWeight(tone, this.options.toneRange)
        if (reach <= 0) continue
        const mode = this.options.kind === 'burn' ? 'burn' : 'dodge'
        for (let channel = 0; channel < 3; channel += 1) {
          image.data[pixel + channel] = Math.round(dodgeBurn(rgb[channel], reach, exposure, mode) * 255)
        }
      }
    }
    this.surface.context.putImageData(image, rect.x, rect.y)
    this.mark(rect)
  }

  /**
   * Spot Healing's dab does not touch the pixels: it records how much of each pixel the brush
   * covered, and `finish` heals the whole lot at once.
   */
  private dabHeal(point: [number, number]): void {
    const coverage = this.coverage
    if (!coverage) return
    const width = this.surface.width
    const height = this.surface.height
    const left = Math.max(0, Math.floor(point[0] - this.radius))
    const right = Math.min(width, Math.ceil(point[0] + this.radius) + 1)
    const top = Math.max(0, Math.floor(point[1] - this.radius))
    const bottom = Math.min(height, Math.ceil(point[1] + this.radius) + 1)
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const weight = tipWeight(
          Math.hypot(x + 0.5 - point[0], y + 0.5 - point[1]),
          this.radius,
          this.options.hardness,
        )
        if (weight <= 0) continue
        const at = y * width + x
        const wanted = Math.round(Math.min(1, Math.max(0, weight * this.options.strength)) * 255)
        if (wanted > coverage[at]) coverage[at] = wanted
        this.covered = true
      }
    }
    if (this.covered) this.mark({ x: left, y: top, width: right - left, height: bottom - top })
  }

  private mark(rect: DirtyRect): void {
    this.covered = true
    this.touched = unionRect(this.touched, rect)
  }
}

/** The half-open bounds of a coverage mask, or null when nothing was covered. */
function coverageRect(coverage: Uint8ClampedArray, width: number, height: number): DirtyRect | null {
  let left = width
  let top = height
  let right = 0
  let bottom = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!coverage[y * width + x]) continue
      if (x < left) left = x
      if (x + 1 > right) right = x + 1
      if (y < top) top = y
      if (y + 1 > bottom) bottom = y + 1
    }
  }
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Fills a selection from the rest of the image, in one go rather than as a stroke.
 *
 * Content-Aware Fill is a menu item in Photoshop rather than a tool, so it has no stroke state: the
 * selection is the coverage, and the whole layer is the image to fill from.
 */
export function fillContentAware(surface: LayerSurface, coverage: Uint8ClampedArray): boolean {
  const image = surface.context.getImageData(0, 0, surface.width, surface.height)
  const filled = contentFill(image, coverage)
  if (filled) surface.context.putImageData(image, 0, 0)
  return filled
}
