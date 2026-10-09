/**
 * A glow.
 *
 * There is nothing to port here. The reference handed bloom to CoreImage's `CIBloom`, whose kernel
 * is not public, so there is no source to copy and none is pretended: what is implemented instead is
 * the behaviour `CIBloom`'s own documentation describes — take the image's highlights, blur them,
 * and add them back to the image. The blur itself comes from `blurred()` in the retouch module,
 * which is a Gaussian approximation over the highlight plane.
 *
 * "The highlights" means the part of each colour channel above a threshold, taken before the blur
 * so that the blur is what spreads them; blurring the whole image and thresholding afterwards would
 * leave a hard edge where the threshold cut. The threshold is half the range, which keeps a mid-grey
 * from contributing and makes a highlight a genuine highlight. Adding the blurred highlight back can
 * only raise a channel, never lower it, so a glow can lighten but cannot darken, and a black image
 * has no highlights to spread and is returned unchanged.
 *
 * `amount` is the multiplier on the blurred highlights, where 1 adds them back at full strength.
 * The reference's Bloom slider ran 0 to 100 and CoreImage's `intensity` was that over 50, so the
 * caller passes `bloomAmount / 50` to get the reference's feel. An amount of 0 is the exact identity
 * rather than source plus nothing, because a slider that has been pulled back to zero must not leave
 * a rounding drift behind.
 *
 * Alpha is carried through untouched. The glow is a light added to the colour that is already there,
 * not a new thing drawn over it.
 */

import { blurred } from '../retouch'
import type { Rgba } from './types'

/** Where a channel stops being part of the image and starts being a highlight, 0 to 1. */
const HIGHLIGHT_THRESHOLD = 0.5

/** A new buffer: the highlights of `source`, blurred with `sigma` and added back `amount` times. */
export function glow(source: Rgba, sigma: number, amount: number): Rgba {
  const data = source.data.slice()
  if (amount === 0) return { data, width: source.width, height: source.height }

  const highlights = new Uint8ClampedArray(source.data.length)
  for (let index = 0; index < source.data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const above = source.data[index + channel] / 255 - HIGHLIGHT_THRESHOLD
      highlights[index + channel] = above > 0 ? above * 255 : 0
    }
    // Opaque, so the blur spreads the colour without also fading it: the highlight plane is a
    // quantity to be spread, not a layer with an edge to soften.
    highlights[index + 3] = 255
  }

  const spread = blurred({ data: highlights, width: source.width, height: source.height }, sigma)
  for (let index = 0; index < data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      data[index + channel] = source.data[index + channel] + amount * spread.data[index + channel]
    }
  }
  return { data, width: source.width, height: source.height }
}
