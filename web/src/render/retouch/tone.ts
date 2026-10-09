/**
 * The tone maths behind the Dodge, Burn and Sponge brushes.
 *
 * The reference app has no such brush — its Blur tool's third mode is Smudge, and the rest of
 * `BlurTool.swift` is CoreImage's — so unlike the other modules here there is nothing to port. What
 * there is instead is Photoshop's own behaviour, and, for the tone ranges, a second copy of an idea
 * that already exists in the shader: `tonal_weights` in `web/src/render/adjust.wgsl` uses the same
 * three overlapping curves to decide how much of a colour-balance shift each tone receives. This
 * file and that shader are two copies of one idea, and they have to be changed together. The blend
 * maths has the same standing warning in the docs: the GPU and the CPU each keep a copy, and a
 * change to one that is not mirrored in the other is a bug that only shows as the tool and the
 * preview disagreeing.
 *
 * The one deliberate difference is the scale. The shader multiplies all three weights by 0.7 before
 * adding its shift, which keeps a full colour-balance correction from overshooting; here the weights
 * meet at one — each is 1 at the centre of its own range and the three sum to 1 across the whole
 * curve — because a dodge at full strength on a shadow should do its whole job, not seven tenths of
 * it. The curves themselves, including the 0.25 half-width and the 0.333 threshold, are the
 * shader's.
 *
 * One dab of any of these is a small step: the tool is meant to build up as the brush is dragged,
 * so a single dab must not slam a pixel to white. That is why each takes a `weight` (how much of
 * the tone range the brush reaches) as well as an `exposure` (the brush's own strength), and why the
 * identity at either zero is exact rather than nearly so.
 */

/** Which part of the tone range a dodge or burn brush reaches. */
export type ToneRange = 'shadows' | 'midtones' | 'highlights'

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * How strongly a brush set to `range` reaches a tone, 0…1. Three overlapping curves.
 *
 * Mirrors `tonal_weights` in `adjust.wgsl` without its 0.7 attenuation: a raised-cosine-ish ramp
 * centred on 0, 0.5 and 1, each one wide enough to overlap its neighbour, so no tone is claimed by
 * nothing and there is no step at a threshold. The three sum to 1 over 0…1, which is what lets the
 * caller treat a full-strength brush as producing exactly one pixel's worth of change at any tone.
 */
export function toneWeight(tone: number, range: ToneRange): number {
  const halfWidth = 0.25
  const threshold = 0.333
  const shadows = clamp01((tone - threshold) / -halfWidth + 0.5)
  const highlights = clamp01((tone + threshold - 1) / halfWidth + 0.5)
  const midtonesLow = clamp01((tone - threshold) / halfWidth + 0.5)
  const midtonesHigh = clamp01((tone + threshold - 1) / -halfWidth + 0.5)
  switch (range) {
    case 'shadows':
      return shadows
    case 'midtones':
      return midtonesLow * midtonesHigh
    case 'highlights':
      return highlights
  }
}

/**
 * One channel, 0…1, after a dodge or burn dab.
 *
 * The step is a linear interpolation towards the target tone — white for a dodge, black for a burn
 * — by `weight × exposure`. Interpolation rather than a fixed increment because it is its own
 * inverse-limit: repeated dabs approach white geometrically and never overshoot it, so a drag that
 * lingers builds up smoothly and a value of 1 stays at 1 under a dodge, while a fixed additive step
 * would need clamping that shows as banding. It is also exactly the identity at zero: a zero step
 * adds exactly nothing, with no rounding to trip over, which is what the caller relies on when a
 * slider is at 0.
 */
export function dodgeBurn(value: number, weight: number, exposure: number, mode: 'dodge' | 'burn'): number {
  const step = clamp01(weight) * clamp01(exposure)
  const target = mode === 'dodge' ? 1 : 0
  return clamp01(value + (target - value) * step)
}

/** The hue of a colour in degrees, given its already-computed extremes. */
function hueOf(red: number, green: number, blue: number, max: number, min: number): number {
  const span = max - min
  if (span === 0) return 0
  let hue: number
  if (max === red) hue = ((green - blue) / span) % 6
  else if (max === green) hue = (blue - red) / span + 2
  else hue = (red - green) / span + 4
  hue *= 60
  return hue < 0 ? hue + 360 : hue
}

/** A colour from hue, HSL saturation and HSL lightness, each 0…1 except the hue in degrees. */
function fromHsl(hueDegrees: number, saturation: number, lightness: number): [number, number, number] {
  const hue = ((hueDegrees % 360) + 360) % 360
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const sector = hue / 60
  const second = chroma * (1 - Math.abs((sector % 2) - 1))
  let rgb: [number, number, number]
  if (sector < 1) rgb = [chroma, second, 0]
  else if (sector < 2) rgb = [second, chroma, 0]
  else if (sector < 3) rgb = [0, chroma, second]
  else if (sector < 4) rgb = [0, second, chroma]
  else if (sector < 5) rgb = [second, 0, chroma]
  else rgb = [chroma, 0, second]
  const floor = lightness - chroma / 2
  return [clamp01(rgb[0] + floor), clamp01(rgb[1] + floor), clamp01(rgb[2] + floor)]
}

/**
 * One colour after a sponge dab, 0…1 per channel, moving saturation towards 1 or towards 0.
 *
 * Saturation and lightness are HSL's, which is what keeps a sponge from darkening as it drains
 * colour: moving HSL saturation leaves the channel midpoint — the perceived lightness — where it
 * was, whereas moving HSV saturation would slide value around and a desaturating stroke would come
 * out muddy rather than grey. The hue is held too, so a blue stays blue.
 *
 * A grey is returned untouched either way. It has no hue to amplify, and the usual fix — inventing
 * one, usually red — would be a colour the user never put there; it also makes "no saturation to
 * move" true in the direction that would otherwise change the pixel.
 */
export function sponge(
  rgb: readonly [number, number, number],
  weight: number,
  exposure: number,
  saturating: boolean,
): [number, number, number] {
  const step = clamp01(weight) * clamp01(exposure)
  const [red, green, blue] = rgb
  if (step === 0) return [red, green, blue]
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  if (max === min) return [red, green, blue]
  const lightness = (max + min) / 2
  const denominator = 1 - Math.abs(2 * lightness - 1)
  const saturation = denominator === 0 ? 0 : (max - min) / denominator
  const hue = hueOf(red, green, blue, max, min)
  const target = saturating ? 1 : 0
  return fromHsl(hue, clamp01(saturation + (target - saturation) * step), lightness)
}
