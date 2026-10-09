/**
 * Radial lens distortion.
 *
 * A port of `lens_distort` from `Compositor/Rendering/LensPixels.c`, mechanical and kept that way.
 * Every destination pixel looks up the source at its own offset from the image centre, scaled by
 * `1 − k·r²`, where `r` is that offset in units of the half-diagonal. Each destination pixel
 * therefore *pulls* its sample from somewhere along the ray through it: a positive `k` samples
 * nearer the centre and so magnifies the image (which straightens barrel distortion, bowing
 * outward, by pulling the bowed lines back), a negative `k` samples further out and shrinks it
 * (straightening pincushion). The sample is bilinear, and anything the lookup lands outside the
 * source is left transparent rather than clamped, which is what leaves the corners clear under a
 * negative `k`.
 *
 * The radius the scale is measured against is the full half-width and half-height, so on a
 * non-square image the distortion is elliptical: the corners move by the same fraction of their own
 * distance, which is the reference's choice and not a bug. `k = 0` copies exactly — the scale is 1,
 * the sample lands on the pixel centre, and the bilinear weights collapse to a single term.
 *
 * Rows run top-down here and top-down in the reference too, and the warp is symmetric about the
 * centre, so unlike the vignette there is no `y` to flip.
 */

import type { Rgba } from './types'

/** Rounds half away from zero, as C's `lround` does. The sums are never negative, but the
 *  reference is stated in terms of `lround` and the distinction costs nothing to keep. */
function lround(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/**
 * `source` is read, `destination` is written, both the same size. `k` is the reference's strength,
 * where a positive value pulls samples inward and a negative one pushes them outward.
 */
export function lensDistort(source: Rgba, destination: Rgba, k: number): void {
  const width = source.width
  const height = source.height
  if (width !== destination.width || height !== destination.height) return
  if (width === 0 || height === 0) return

  const centreX = width * 0.5
  const centreY = height * 0.5
  const halfDiagonal2 = centreX * centreX + centreY * centreY
  const inData = source.data
  const outData = destination.data

  for (let y = 0; y < height; y += 1) {
    const dy = y + 0.5 - centreY
    for (let x = 0; x < width; x += 1) {
      const dx = x + 0.5 - centreX
      const scale = 1 - (k * (dx * dx + dy * dy)) / halfDiagonal2
      // Source position in pixel-centre coordinates.
      const sx = centreX + dx * scale - 0.5
      const sy = centreY + dy * scale - 0.5
      const floorX = Math.floor(sx)
      const floorY = Math.floor(sy)
      const fx = sx - floorX
      const fy = sy - floorY
      const x0 = floorX
      const y0 = floorY

      const sums = [0, 0, 0, 0]
      for (let j = 0; j < 2; j += 1) {
        const row = y0 + j
        if (row < 0 || row >= height) continue
        const wy = j ? fy : 1 - fy
        if (wy === 0) continue
        for (let i = 0; i < 2; i += 1) {
          const column = x0 + i
          if (column < 0 || column >= width) continue
          const weight = wy * (i ? fx : 1 - fx)
          if (weight === 0) continue
          const at = (row * width + column) * 4
          for (let channel = 0; channel < 4; channel += 1) sums[channel] += weight * inData[at + channel]
        }
      }

      const out = (y * width + x) * 4
      for (let channel = 0; channel < 4; channel += 1) outData[out + channel] = lround(sums[channel])
    }
  }
}
