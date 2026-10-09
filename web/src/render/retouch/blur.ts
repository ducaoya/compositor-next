/**
 * A Gaussian, and the unsharp mask built from it, over a plain RGBA rectangle.
 *
 * The Blur tool's softening in the reference app is CoreImage's, so there is nothing to port but
 * the sigma the tool asks for (`BlurTool.swift` derives it from the brush radius and the layer's
 * scale, which the caller does before calling here). The blur itself is implemented as three
 * successive box passes, the usual approximation: each box of width w has the same variance as a
 * Gaussian of sigma = sqrt((w² - 1) / 12), and three of them in a row are within a fraction of a
 * percent of the real thing. Boxes rather than an explicit kernel because the window is a running
 * sum, so the cost does not grow with sigma — a 50-pixel blur costs the same as a 2-pixel one —
 * and because the only places the two differ observably are the far tails, which the unsharp mask
 * multiplies by zero anyway.
 *
 * Edges clamp to the edge pixel rather than fading out. That matters: the caller blurs a region
 * near a layer's edge, and a window that treated the outside as transparent would darken the border
 * and pull the layer's alpha down along it. Clamping is also what a canvas does when it draws a
 * blurred copy of a layer, so a region blurred here matches one blurred on the canvas.
 *
 * Alpha is blurred along with colour. That is what makes a soft-edged layer stay soft through a
 * second blur instead of growing a hard alpha edge.
 *
 * Both functions leave `source` untouched.
 */

import type { Rgba } from './types'

/**
 * The three box radii the standard approximation picks for a sigma.
 *
 * The three widths are either wl or wu, the two odd integers either side of the ideal width, and
 * the split is chosen so the combined variance lands on sigma². The reference is the usual
 * derivation; there is nothing app-specific about it, which is why it is stated here rather than
 * credited line by line.
 */
function boxRadii(sigma: number): [number, number, number] {
  const passes = 3
  const idealWidth = Math.sqrt((12 * sigma * sigma) / passes + 1)
  let lower = Math.floor(idealWidth)
  if (lower % 2 === 0) lower -= 1
  const upper = lower + 2
  const idealCount =
    (12 * sigma * sigma - passes * lower * lower - 4 * passes * lower - 3 * passes) / (-4 * lower - 4)
  const split = Math.round(idealCount)
  const widths = [0, 1, 2].map((index) => (index < split ? lower : upper))
  return widths.map((width) => (width - 1) / 2) as [number, number, number]
}

function clampIndex(index: number, limit: number): number {
  return index < 0 ? 0 : index >= limit ? limit - 1 : index
}

/** One box blur along one axis, as a new buffer, with the window clamped at both edges. */
function boxAxis(
  input: Float64Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
): Float64Array {
  const output = new Float64Array(input.length)
  const window = radius * 2 + 1
  const outer = horizontal ? height : width
  const inner = horizontal ? width : height
  // A pixel is four channels apart along a row, and a whole row apart down a column.
  const step = horizontal ? 4 : width * 4

  for (let line = 0; line < outer; line += 1) {
    const base = line * (horizontal ? width : 1) * 4
    for (let channel = 0; channel < 4; channel += 1) {
      let sum = 0
      for (let offset = -radius; offset <= radius; offset += 1) {
        sum += input[base + clampIndex(offset, inner) * step + channel]
      }
      for (let position = 0; position < inner; position += 1) {
        const at = base + position * step + channel
        output[at] = sum / window
        const arriving = clampIndex(position + radius + 1, inner)
        const leaving = clampIndex(position - radius, inner)
        sum += input[base + arriving * step + channel]
        sum -= input[base + leaving * step + channel]
      }
    }
  }
  return output
}

/** Three box passes, each separable, which together are the Gaussian. */
function approximateBlur(source: Rgba, sigma: number): Float64Array {
  let work: Float64Array = new Float64Array(source.data.length)
  for (let index = 0; index < source.data.length; index += 1) work[index] = source.data[index]
  for (const radius of boxRadii(sigma)) {
    work = boxAxis(work, source.width, source.height, radius, true)
    work = boxAxis(work, source.width, source.height, radius, false)
  }
  return work
}

/** A separable Gaussian over the whole buffer, alpha included, as a new buffer. */
export function blurred(source: Rgba, sigma: number): Rgba {
  if (!(sigma > 0)) return { data: source.data.slice(), width: source.width, height: source.height }
  const work = approximateBlur(source, sigma)
  const data = new Uint8ClampedArray(source.data.length)
  for (let index = 0; index < data.length; index += 1) data[index] = work[index]
  return { data, width: source.width, height: source.height }
}

/**
 * An unsharp mask: source + amount * (source - blurred), clamped.
 *
 * This is Photoshop's sharpening form — the blurred copy is what the eye reads as the low
 * frequency, and subtracting it leaves the detail — with the byte clamp doing the limiting that
 * Photoshop expresses as a threshold. `amount` 0 is an exact copy rather than a source plus zero,
 * because the caller resets the radius slider to zero often enough that a rounding drift there
 * would show.
 */
export function sharpened(source: Rgba, sigma: number, amount: number): Rgba {
  const data = new Uint8ClampedArray(source.data.length)
  if (amount === 0) {
    data.set(source.data)
    return { data, width: source.width, height: source.height }
  }
  const work = approximateBlur(source, sigma)
  for (let index = 0; index < data.length; index += 1) {
    const sharp = source.data[index]
    data[index] = sharp + amount * (sharp - work[index])
  }
  return { data, width: source.width, height: source.height }
}
