/**
 * Tonal Contrast.
 *
 * A port of `adjust_tonal_contrast` from `Compositor/Rendering/AdjustPixels.c`. Local contrast: a
 * pixel is pushed away from a blurred copy of itself, so the detail that the blur smoothed away is
 * what comes back — the farther the pixel is from its neighbourhood average, the harder it is
 * pushed. The push is scaled by two things. One is the tone range the pixel sits in, taken from the
 * *blurred* luminance rather than the pixel's own, so the boundary between shadows and highlights
 * does not move as the detail is added. The other is `4·lum·(1−lum)`, which is zero at black and
 * white and peaks at mid-grey: the ends of the range cannot be pushed further out, so there is
 * nothing to gain there.
 *
 * The blur is not made here. CoreImage made it in the reference (`applyingGaussianBlur`), and the
 * caller makes it here with `blurred()` from the retouch module; all this kernel does is read the
 * two buffers. That keeps the radius policy — how a preview's radius is scaled, and what happens at
 * the layer's edge — with the caller, where the reference keeps it too.
 *
 * Alpha is read but never written: the reference's `write_premultiplied` would have re-premultiplied
 * the result, and as in `vignette.ts` this port works on the straight-alpha bytes a canvas gives
 * out, so the colour channels are written straight and the alpha is left as it was. A pixel that is
 * clear in either buffer is skipped, as the reference skips it.
 */

import type { Rgba } from './types'

export interface TonalSettings {
  /** 0 to 100. */
  amount: number
  /** −100 to 100: how hard the shadows are pushed. */
  shadows: number
  /** −100 to 100: how hard the midtones are pushed. */
  midtones: number
  /** −100 to 100: how hard the highlights are pushed. */
  highlights: number
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** Rec. 709 luminance, the reference's weighting. */
function rec709(red: number, green: number, blue: number): number {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

/** The reference's smoothstep: 0 below `low`, 1 above `high`, eased between. */
function smooth(low: number, high: number, value: number): number {
  const t = clamp01((value - low) / (high - low))
  return t * t * (3 - 2 * t)
}

/**
 * Local contrast, in place on `pixels`, pushing each pixel away from the matching pixel of
 * `blurred`. Both buffers are the same size; the caller makes `blurred`.
 */
export function tonalContrast(pixels: Rgba, blurred: Rgba, settings: TonalSettings): void {
  const { amount, shadows, midtones, highlights } = settings
  if (amount <= 0 || (shadows === 0 && midtones === 0 && highlights === 0)) return
  if (pixels.width !== blurred.width || pixels.height !== blurred.height) return

  // 50 rather than 100, the reference's scale: an Amount of 50 already doubles the detail.
  const strength = amount / 50
  const data = pixels.data
  const base = blurred.data

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3]
    if (alpha === 0 || base[index + 3] === 0) continue
    const red = data[index] / 255
    const green = data[index + 1] / 255
    const blue = data[index + 2] / 255
    const luminance = rec709(red, green, blue)
    const baseLuminance = rec709(base[index] / 255, base[index + 1] / 255, base[index + 2] / 255)

    const shadowWeight = 1 - smooth(0.15, 0.5, baseLuminance)
    const highlightWeight = smooth(0.5, 0.85, baseLuminance)
    const midtoneWeight = 1 - shadowWeight - highlightWeight
    const weight =
      (shadows * shadowWeight + midtones * midtoneWeight + highlights * highlightWeight) / 100

    const detail = luminance - baseLuminance
    const delta = 0.18 * Math.tanh(detail * 6) * weight * strength * (4 * luminance * (1 - luminance))
    data[index] = Math.round(clamp01(red + delta) * 255)
    data[index + 1] = Math.round(clamp01(green + delta) * 255)
    data[index + 2] = Math.round(clamp01(blue + delta) * 255)
  }
}
