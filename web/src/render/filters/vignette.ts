/**
 * The coloured vignette.
 *
 * A port of `adjust_colored_vignette`, and of the `vignette_mask_at` it shares with Camera Raw, from
 * `Compositor/Rendering/AdjustPixels.c`. The shape of the falloff is the reference's unchanged: a
 * point is measured from the frame's centre in units of half the frame's width and height, the two
 * axes are combined towards a square or a circle by `roundness`, and the result is run through a
 * smoothstep that starts at `midpoint` and is spread over `feather`. The colour is the reference's
 * too: a pixel is interpolated towards it by the local strength, which is what makes this a
 * coloured vignette and not merely a darkening one.
 *
 * Three things had to be reconsidered rather than copied.
 *
 * **Rows.** The reference draws into a CoreGraphics context that it flips on creation, so its rows
 * run top-down as a canvas' do, but the frame it is handed is a bottom-up `CGRect` and it converts
 * that with `height - frame.maxY`. Here the caller hands over a top-down `Bounds`, so the frame's
 * own `y` is already the top edge and no conversion happens: the `height - maxY` is dropped, not
 * translated. Copying it would swap the frame's top and bottom, which is invisible on a centred
 * frame and exactly wrong on an off-centre one, and that is the bug the comment in `Filters.swift`
 * exists to warn about.
 *
 * **Straight alpha.** The reference reads and writes premultiplied bytes, recovering the straight
 * colour by dividing by alpha. A canvas hands out straight-alpha bytes from `getImageData`, so this
 * port reads and writes them straight, the same choice `heal.ts` makes, and for the same reason:
 * round-tripping through a premultiplication would change every opaque pixel's last bit for the
 * sake of the translucent ones. On an opaque pixel the two are identical, which is what the tests
 * pin down.
 *
 * **The sign of `amount`.** The reference's slider runs 0 to 100, and it returns early on anything
 * else, so it only ever blended towards the chosen colour. The caller here exposes a signed slider:
 * a negative amount pulls the corner towards `colour`, which at the default black is the ordinary
 * darkening vignette, and a positive amount pulls it towards white, which is lightening. Positive
 * amounts therefore no longer reach the colour — that is the one place this port knowingly does not
 * reproduce the reference's behaviour, and it is what the two directions of a Photoshop-style
 * Amount mean.
 */

import type { Bounds, Rgba } from './types'

export interface VignetteSettings {
  /** −100 to 100: a negative amount blends the corners towards `colour`, a positive one towards white. */
  amount: number
  /** 0 to 100: where the falloff starts, from the centre outwards. */
  midpoint: number
  /** −100 to 100: how round the falloff is, from a square at −100 to a circle at 100. */
  roundness: number
  /** 0 to 100: how far the falloff is spread. */
  feather: number
  /** 0 to 100: how much the highlights are protected, so bright corners resist the change. */
  highlights: number
  /** The colour the corners are pulled towards, 0 to 255 a channel. */
  colour: [number, number, number]
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** Rec. 709 luminance, the reference's weighting. */
function rec709(red: number, green: number, blue: number): number {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

/**
 * The vignette's strength at a point of the frame: 0 at its middle, 1 past its edges.
 *
 * `px` and `py` are measured from the frame's top-left corner, which is why the sign of the
 * normalised distance matters only through its absolute value: the falloff is symmetric about the
 * frame's centre, so "above" and "below" are the same distance and the top-down origin costs
 * nothing here. The reference's arithmetic is kept term for term.
 */
function vignetteMaskAt(
  px: number,
  py: number,
  width: number,
  height: number,
  midpoint: number,
  roundness: number,
  feather: number,
): number {
  const nx = (px / width) * 2 - 1
  const ny = (py / height) * 2 - 1
  const square = Math.max(Math.abs(nx), Math.abs(ny))
  const circle = Math.hypot(nx, ny) / Math.SQRT2
  const shape = (1 - roundness / 100) * 0.5
  const distance = circle + (square - circle) * shape
  const start = (midpoint / 100) * 0.85
  let soft = feather / 100
  if (soft < 0.05) soft = 0.05
  const t = clamp01((distance - start) / soft)
  return t * t * (3 - 2 * t)
}

/**
 * The vignette, in place on `pixels`, centred and shaped on `frame`.
 *
 * A `frame` equal to the whole image means the canvas *is* the image, which is what the reference's
 * `frameIsCanvas` flag meant: only the pixels that are already there are recoloured and clear ones
 * are skipped. A frame smaller or offset from the image means the frame is the canvas sitting over
 * a larger layer, and then the clear pixels are painted too, gaining alpha where the vignette
 * reaches them — the reference's `fillsClear` branch.
 */
export function vignette(pixels: Rgba, frame: Bounds, settings: VignetteSettings): void {
  const { amount, midpoint, roundness, feather, highlights } = settings
  if (amount === 0 || pixels.width === 0 || pixels.height === 0) return
  if (frame.width <= 0 || frame.height <= 0) return

  const strength = clamp01(Math.abs(amount) / 100)
  // A negative amount darkens towards the chosen colour; a positive one lightens towards white.
  const target: [number, number, number] =
    amount < 0
      ? [clamp01(settings.colour[0] / 255), clamp01(settings.colour[1] / 255), clamp01(settings.colour[2] / 255)]
      : [1, 1, 1]
  const protection = highlights / 100
  const fillsClear =
    frame.x !== 0 || frame.y !== 0 || frame.width !== pixels.width || frame.height !== pixels.height

  const data = pixels.data
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      const at = (y * pixels.width + x) * 4
      const alpha = data[at + 3]
      if (alpha === 0 && !fillsClear) continue
      const mask = vignetteMaskAt(
        x + 0.5 - frame.x,
        y + 0.5 - frame.y,
        frame.width,
        frame.height,
        midpoint,
        roundness,
        feather,
      )
      if (mask <= 0) continue

      const coverage = alpha / 255
      let red = 0
      let green = 0
      let blue = 0
      let bright = 0
      if (alpha !== 0) {
        red = data[at] / 255
        green = data[at + 1] / 255
        blue = data[at + 2] / 255
        bright = clamp01((rec709(red, green, blue) - 0.45) / 0.55)
      }
      const effect = strength * mask * (1 - protection * bright)

      if (!fillsClear) {
        data[at] = Math.round(clamp01(red + (target[0] - red) * effect) * 255)
        data[at + 1] = Math.round(clamp01(green + (target[1] - green) * effect) * 255)
        data[at + 2] = Math.round(clamp01(blue + (target[2] - blue) * effect) * 255)
        continue
      }

      // The colour painted over the pixel at `effect`: an opaque pixel moves towards it, a clear one
      // takes it on and gains the coverage.
      const out = coverage + effect * (1 - coverage)
      if (out <= 0) continue
      const mixedRed = (target[0] * effect + red * coverage * (1 - effect)) / out
      const mixedGreen = (target[1] * effect + green * coverage * (1 - effect)) / out
      const mixedBlue = (target[2] * effect + blue * coverage * (1 - effect)) / out
      data[at + 3] = Math.min(255, Math.round(out * 255))
      data[at] = Math.round(clamp01(mixedRed) * 255)
      data[at + 1] = Math.round(clamp01(mixedGreen) * 255)
      data[at + 2] = Math.round(clamp01(mixedBlue) * 255)
    }
  }
}
