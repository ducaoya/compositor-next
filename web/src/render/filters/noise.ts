/**
 * Add Noise.
 *
 * A port of `noise_add_at` from `Compositor/Rendering/NoisePixels.c`. There is no random number
 * generator and no table: a pixel's noise is a 32-bit hash of its position mixed with the seed, so
 * the grain is a pure function of where the pixel is and what seed the caller chose. That is the
 * whole point of it — the same seed has to give the same grain when a project is reopened, and only
 * a position-derived hash guarantees it. The hash, the per-pixel mix and both draws are the
 * reference's bit for bit, `Math.imul` and `>>> 0` standing in for the C's wrapping `uint32_t`.
 *
 * The reference's `origin_x` and `origin_y` exist so a live preview drawn in tiles reads one
 * continuous noise field rather than restarting the grain in each tile. Nothing here is tiled, so
 * the origin is the image's own top-left and the arguments are dropped.
 *
 * `amount` is Photoshop's percentage: uniform noise spans ±`amount`% of half the range, and the
 * Gaussian's standard deviation is two thirds of that. Monochromatic takes the same draw on all
 * three channels, which is the difference between film grain and chroma noise. Alpha is never
 * touched and a fully transparent pixel is skipped, because there is no colour there to move.
 *
 * The hash and `noise_unit` are exact; the Gaussian's `sqrt`, `log` and `cos` are evaluated in
 * double rather than the C's single precision, which can move a byte only when the value lands on a
 * rounding boundary. The draws are still the same draw of the same uniform values, so the grain is
 * the same shape; it is only that last bit that is not claimed.
 */

import type { Rgba } from './types'

export interface NoiseSettings {
  /** Photoshop's percentage. */
  amount: number
  gaussian: boolean
  monochromatic: boolean
  seed: number
}

/** The reference's 32-bit hash, so neighbouring pixels get unrelated values. */
function noiseHash(input: number): number {
  let value = input >>> 0
  value = (value ^ (value >>> 16)) >>> 0
  value = Math.imul(value, 0x7feb352d) >>> 0
  value = (value ^ (value >>> 15)) >>> 0
  value = Math.imul(value, 0x846ca68b) >>> 0
  value = (value ^ (value >>> 16)) >>> 0
  return value >>> 0
}

/** Uniform in [0, 1), taken from the top 24 bits so the result is exact. */
function noiseUnit(key: number): number {
  return (noiseHash(key) >>> 8) * (1 / 16777216)
}

/** Adds noise in place, leaving alpha and fully transparent pixels alone. */
export function addNoise(pixels: Rgba, settings: NoiseSettings): void {
  const { amount, gaussian, monochromatic } = settings
  const spread = (amount / 100) * 127.5
  if (spread === 0) return
  // The seed is a uint32 at the boundary; `>>> 0` is what keeps a negative or fractional one from
  // poisoning every hash downstream.
  const seed = settings.seed >>> 0
  const data = pixels.data

  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      const at = (y * pixels.width + x) * 4
      const alpha = data[at + 3]
      if (alpha === 0) continue

      const mixed =
        (Math.imul(x, 0x9e3779b9) ^ noiseHash(Math.imul(y, 0x85ebca6b))) >>> 0
      const base = noiseHash((seed ^ noiseHash(mixed)) >>> 0)

      for (let channel = 0; channel < 3; channel += 1) {
        const key = monochromatic ? base : (base + Math.imul(channel, 0x9e3779b9)) >>> 0
        let noise: number
        if (gaussian) {
          // Box–Muller: two uniform values make one normally distributed one.
          const u1 = noiseUnit(key)
          const u2 = noiseUnit((key ^ 0x68e31da4) >>> 0)
          noise = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2) * spread * (2 / 3)
        } else {
          noise = (noiseUnit(key) * 2 - 1) * spread
        }
        let value = (data[at + channel] * 255) / alpha + noise
        value = value < 0 ? 0 : value > 255 ? 255 : value
        data[at + channel] = Math.round((value * alpha) / 255)
      }
    }
  }
}
