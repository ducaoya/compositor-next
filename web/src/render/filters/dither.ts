/**
 * Dither: reducing the colours an image has, on purpose, and spreading the error.
 *
 * The three methods are the ones Photoshop's Indexed mode offers, because those are the three that
 * solve different problems rather than being three spellings of one:
 *
 * - **Diffusion** carries each pixel's error into its neighbours (Floyd–Steinberg), which is the one
 *   to reach for on a photograph: it keeps the local average, so a gradient stays a gradient.
 * - **Pattern** adds a fixed threshold from an 8×8 Bayer matrix, which makes a regular texture out of
 *   the error. It is what a screen for print or a pixel-art ramp wants, and it is stable: the same
 *   pixel always lands the same way, whatever is around it.
 * - **Noise** adds a pseudo-random offset instead, which breaks up the banding without the visible
 *   cross-hatch a pattern leaves. The offset is a hash of the pixel's position, so the same seed
 *   gives the same grain when a project is reopened.
 *
 * `monochromatic` is Photoshop's one-bit grey look: the whole pixel is decided from its luminance and
 * written to all three channels, rather than each channel being quantized on its own. Diffusion plus
 * monochromatic at two levels is the classic 1-bit newspaper halftone; the same settings without it
 * give a colour poster.
 *
 * The diffusion error lives in two row buffers rather than one plane over the image. A full
 * accumulator would be three floats a pixel — a 4,000 × 4,000 layer would need 192 MB to dither
 * — and a pixel only ever hands error to the row it is in and the one below it, so that is all that
 * has to be kept.
 *
 * Alpha is never touched, and a fully transparent pixel is skipped: there is no colour there to
 * quantize, and spreading an error into transparency would only invent one.
 */

import type { Rgba } from './types'

export interface DitherSettings {
  method: 'diffusion' | 'pattern' | 'noise'
  /** How many values a channel may end up with. Two is one bit, which is Photoshop's Bitmap mode. */
  levels: number
  /** How much of the quantization error is passed on, 0–100. Photoshop's dithers carry all of it. */
  amount: number
  /** Diffusion only: reverse every other row, which stops error from being pushed one way. */
  serpentine: boolean
  /** Decide the whole pixel from its luminance instead of quantizing each channel. */
  monochromatic: boolean
  seed: number
}

/** The 8×8 Bayer matrix, ordered 0–63: the threshold pattern a pattern dither is made of. */
const BAYER_8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
]

/** The reference's 32-bit mix, taken from the noise filter so a seed means the same thing here. */
function hash(input: number): number {
  let value = input >>> 0
  value = (value ^ (value >>> 16)) >>> 0
  value = Math.imul(value, 0x7feb352d) >>> 0
  value = (value ^ (value >>> 15)) >>> 0
  value = Math.imul(value, 0x846ca68b) >>> 0
  return (value ^ (value >>> 16)) >>> 0
}

/** Uniform in [0, 1), from the top 24 bits so the result is exact. */
function unit(key: number): number {
  return (hash(key) >>> 8) * (1 / 16777216)
}

/** The luminance Photoshop's own conversions use, which is what decides a monochromatic pixel. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/**
 * Dithers in place.
 *
 * `levels` is clamped to something a channel can actually hold: one value is an image of one colour,
 * and more than 256 is the image that came in.
 */
export function dither(pixels: Rgba, settings: DitherSettings): void {
  const levels = Math.max(2, Math.min(256, Math.round(settings.levels)))
  if (levels >= 256) return
  const step = 255 / (levels - 1)
  const carry = Math.max(0, Math.min(100, settings.amount)) / 100
  if (step === 0) return

  const data = pixels.data
  const width = pixels.width
  const height = pixels.height
  const seed = settings.seed >>> 0

  /** The quantized value nearest to `value`, which is also what is written to the pixel. */
  const quantize = (value: number): number => Math.round(Math.max(0, Math.min(255, value)) / step) * step

  if (settings.method === 'diffusion') {
    // Two rows of error, three channels each: the row being written, and the one below it arriving.
    const current = new Float32Array((width + 2) * 3)
    const below = new Float32Array((width + 2) * 3)
    for (let y = 0; y < height; y += 1) {
      // Serpentine walks right to left on every other row, so the error does not all drift one way.
      const backwards = settings.serpentine && y % 2 === 1
      for (let index = 0; index < width; index += 1) {
        const x = backwards ? width - 1 - index : index
        const at = (y * width + x) * 4
        if (data[at + 3] === 0) continue
        const slot = (x + 1) * 3

        if (settings.monochromatic) {
          const red = data[at]
          const green = data[at + 1]
          const blue = data[at + 2]
          // The decision is on the luminance the pixel *would* have, error included — and the error
          // has to be what would-have minus what-is. Handing on only the pixel's own difference
          // would drop the error that arrived, which is how a dither turns back into a threshold.
          const wanted = luma(red, green, blue) + current[slot]
          const decided = quantize(wanted)
          const error = (wanted - decided) * carry
          data[at] = decided
          data[at + 1] = decided
          data[at + 2] = decided
          // One error, put back into all three planes: the decision reads the luminance error, and
          // three planes that disagree would make the next pixel's decision depend on which channel
          // happened to carry it.
          spread(current, below, slot, error, backwards)
          spread(current, below, slot + 1, error, backwards)
          spread(current, below, slot + 2, error, backwards)
          continue
        }

        for (let channel = 0; channel < 3; channel += 1) {
          const wanted = data[at + channel] + current[slot + channel]
          const decided = quantize(wanted)
          data[at + channel] = decided
          spread(current, below, slot + channel, (wanted - decided) * carry, backwards)
        }
      }
      current.set(below)
      below.fill(0)
    }
    return
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4
      if (data[at + 3] === 0) continue
      // Both remaining methods are the same arithmetic: decide from the value plus an offset that
      // spans one quantization step, and only the offset differs.
      if (settings.method === 'pattern') {
        const threshold = (BAYER_8[y % 8][x % 8] + 0.5) / 64 - 0.5
        const offset = threshold * step * carry
        if (settings.monochromatic) {
          const decided = quantize(luma(data[at], data[at + 1], data[at + 2]) + offset)
          data[at] = decided
          data[at + 1] = decided
          data[at + 2] = decided
        } else {
          for (let channel = 0; channel < 3; channel += 1) {
            data[at + channel] = quantize(data[at + channel] + offset)
          }
        }
        continue
      }

      const mixed = (Math.imul(x, 0x9e3779b9) ^ hash(Math.imul(y, 0x85ebca6b))) >>> 0
      const base = hash((seed ^ hash(mixed)) >>> 0)
      if (settings.monochromatic) {
        const offset = (unit(base) - 0.5) * step * carry
        const decided = quantize(luma(data[at], data[at + 1], data[at + 2]) + offset)
        data[at] = decided
        data[at + 1] = decided
        data[at + 2] = decided
      } else {
        for (let channel = 0; channel < 3; channel += 1) {
          const key = (base + Math.imul(channel, 0x9e3779b9)) >>> 0
          data[at + channel] = quantize(data[at + channel] + (unit(key) - 0.5) * step * carry)
        }
      }
    }
  }
}

/**
 * Floyd–Steinberg: 7/16 to the next pixel, 3/16, 5/16 and 1/16 to the three below it.
 *
 * `backwards` mirrors the horizontal offsets for a serpentine row, so the weights stay the same
 * shape while the direction of travel flips.
 */
function spread(
  current: Float32Array,
  below: Float32Array,
  slot: number,
  error: number,
  backwards: boolean,
): void {
  const forward = backwards ? -1 : 1
  current[slot + forward * 3] += (error * 7) / 16
  below[slot - forward * 3] += (error * 3) / 16
  below[slot] += (error * 5) / 16
  below[slot + forward * 3] += error / 16
}
