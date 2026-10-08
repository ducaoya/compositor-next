/**
 * Rendering layer effects into a raster the compositor can draw.
 *
 * The coverages come from `model/effects.ts` as masks; this turns them into pixels. Everything is
 * premultiplied RGBA, because that is what the accumulation texture holds and what source-over
 * wants, and it is built by hand rather than with Canvas2D because the "over the layer but not
 * beyond it" rule for inner effects is not something a composite operation expresses.
 *
 * The result is a raster *larger* than the layer's, by the effects' margin on every side, and a
 * transform adjusted to match — so the layer's own pixels land exactly where they did and the
 * shadow has somewhere to fall.
 */

import { effectsMargin, overPaints, underPaints, type LayerEffects } from '../model/effects'
import type { Mask } from '../model/selectionMask'
import { createMask } from '../model/selectionMask'
import type { Transform } from '../model/types'
import type { LayerSurface } from './paint'

export interface EffectsRender {
  canvas: OffscreenCanvas
  /** The layer's transform, grown to cover the margin. */
  transform: Transform
}

/** The alpha channel as coverage, and the layer mask applied to it. */
function coverageOf(pixels: LayerSurface, mask: LayerSurface | null): Mask {
  const image = pixels.context.getImageData(0, 0, pixels.width, pixels.height)
  const coverage = createMask(pixels.width, pixels.height)
  for (let index = 0; index < coverage.data.length; index += 1) {
    coverage.data[index] = image.data[index * 4 + 3]
  }
  if (!mask) return coverage
  const maskImage = mask.context.getImageData(0, 0, mask.width, mask.height)
  for (let y = 0; y < coverage.height; y += 1) {
    const maskY = Math.min(mask.height - 1, Math.round((y / Math.max(1, coverage.height - 1)) * (mask.height - 1)))
    for (let x = 0; x < coverage.width; x += 1) {
      const maskX = Math.min(mask.width - 1, Math.round((x / Math.max(1, coverage.width - 1)) * (mask.width - 1)))
      const at = y * coverage.width + x
      coverage.data[at] = Math.round((coverage.data[at] * maskImage.data[(maskY * mask.width + maskX) * 4]) / 255)
    }
  }
  return coverage
}

/**
 * Composites one effect over the buffer.
 *
 * `atop` keeps the destination's alpha, which is what makes an inner shadow stay inside the shape:
 * a fill would raise the coverage and leave a halo where the layer was semi-transparent.
 */
function paintCoverage(
  out: Uint8ClampedArray,
  width: number,
  height: number,
  offset: number,
  coverage: Mask,
  color: [number, number, number],
  opacity: number,
  atop: boolean,
): void {
  const rgb: [number, number, number] = [color[0] * 255, color[1] * 255, color[2] * 255]
  for (let y = 0; y < height; y += 1) {
    const sourceY = y - offset
    if (sourceY < 0 || sourceY >= coverage.height) continue
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - offset
      if (sourceX < 0 || sourceX >= coverage.width) continue
      const amount = (coverage.data[sourceY * coverage.width + sourceX] / 255) * opacity
      if (amount <= 0) continue
      const at = (y * width + x) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        out[at + channel] = rgb[channel] * amount + out[at + channel] * (1 - amount)
      }
      if (!atop) {
        const alpha = out[at + 3] / 255
        out[at + 3] = Math.round(Math.min(1, amount + alpha * (1 - amount)) * 255)
      }
    }
  }
}

/** The layer's own pixels, shifted into the grown raster. */
function paintLayer(
  out: Uint8ClampedArray,
  width: number,
  height: number,
  offset: number,
  pixels: LayerSurface,
  mask: LayerSurface | null,
): void {
  const image = pixels.context.getImageData(0, 0, pixels.width, pixels.height)
  const maskImage = mask ? mask.context.getImageData(0, 0, mask.width, mask.height) : null
  for (let y = 0; y < pixels.height; y += 1) {
    const targetY = y + offset
    if (targetY < 0 || targetY >= height) continue
    for (let x = 0; x < pixels.width; x += 1) {
      const targetX = x + offset
      if (targetX < 0 || targetX >= width) continue
      const from = (y * pixels.width + x) * 4
      const at = (targetY * width + targetX) * 4
      let alpha = image.data[from + 3]
      if (maskImage) {
        const maskY = Math.min(mask!.height - 1, Math.round((y / Math.max(1, pixels.height - 1)) * (mask!.height - 1)))
        const maskX = Math.min(mask!.width - 1, Math.round((x / Math.max(1, pixels.width - 1)) * (mask!.width - 1)))
        alpha = Math.round((alpha * maskImage.data[(maskY * mask!.width + maskX) * 4]) / 255)
      }
      if (alpha === 0) continue
      const scale = alpha / Math.max(1, image.data[from + 3])
      for (let channel = 0; channel < 3; channel += 1) {
        // The source is stored straight, so premultiplying is what makes source-over correct.
        out[at + channel] = Math.round(image.data[from + channel] * scale)
      }
      out[at + 3] = alpha
    }
  }
}

/**
 * Renders a layer with its effects, or null when there are none to draw.
 *
 * The order is Photoshop's: the drop shadow and outer glow go underneath, the layer sits on them,
 * and the inner shadow, inner glow, colour overlay and stroke go over it.
 */
export function renderEffects(
  pixels: LayerSurface,
  mask: LayerSurface | null,
  effects: LayerEffects,
  transform: Transform,
): EffectsRender | null {
  const margin = effectsMargin(effects)
  if (margin <= 0) return null

  const width = pixels.width + margin * 2
  const height = pixels.height + margin * 2
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) return null

  const image = context.createImageData(width, height)
  const coverage = coverageOf(pixels, mask)

  for (const paint of underPaints(coverage, effects)) {
    paintCoverage(image.data, width, height, margin, paint.coverage, paint.color, paint.opacity, false)
  }
  paintLayer(image.data, width, height, margin, pixels, mask)
  for (const paint of overPaints(coverage, effects)) {
    paintCoverage(image.data, width, height, margin, paint.coverage, paint.color, paint.opacity, true)
  }

  context.putImageData(image, 0, 0)

  // The raster grew, so the transform has to grow with it. Keeping the centre fixed is what makes
  // the layer's own pixels land exactly where they were, rotation included.
  const scaleX = transform.size[0] / Math.max(1, pixels.width)
  const scaleY = transform.size[1] / Math.max(1, pixels.height)
  const size: [number, number] = [width * scaleX, height * scaleY]
  const centre: [number, number] = [
    transform.origin[0] + transform.size[0] / 2,
    transform.origin[1] + transform.size[1] / 2,
  ]
  return {
    canvas,
    transform: {
      ...transform,
      origin: [centre[0] - size[0] / 2, centre[1] - size[1] / 2],
      size,
    },
  }
}
