/**
 * The blend maths, in the space Photoshop blends in: **sRGB-encoded values, not linear light**.
 *
 * The reference app calls this out explicitly, and it is the difference between a Multiply that
 * looks right and one that looks muddy. Every function here works on un-premultiplied channels in
 * 0..1. The WGSL in `render/blend.wgsl` is a line-for-line port of this file, and a test compares
 * the two lists of function names so they cannot drift.
 */

import type { BlendModeName } from './types'

export type RGB = [number, number, number]

/** The four modes that read all three channels at once. */
export const NON_SEPARABLE: ReadonlySet<BlendModeName> = new Set([
  'Hue',
  'Saturation',
  'Color',
  'Luminosity',
])

export function luminance([r, g, b]: RGB): number {
  return 0.3 * r + 0.59 * g + 0.11 * b
}

export function saturation([r, g, b]: RGB): number {
  return Math.max(r, g, b) - Math.min(r, g, b)
}

/** Pulls a colour back into gamut without changing its hue, per the W3C compositing spec. */
export function clipColor(color: RGB): RGB {
  const l = luminance(color)
  const n = Math.min(...color)
  const x = Math.max(...color)
  let out: RGB = [...color]
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n)) as RGB
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as RGB
  return out
}

/** Shifts a colour to luminance `l`, keeping its chroma. */
export function setLuminance(color: RGB, l: number): RGB {
  const d = l - luminance(color)
  return clipColor(color.map((v) => v + d) as RGB)
}

/** Scales a colour to saturation `s`, keeping its hue. */
export function setSaturation(color: RGB, s: number): RGB {
  const min = Math.min(...color)
  const max = Math.max(...color)
  if (max === min) return [0, 0, 0]
  const scale = s / (max - min)
  return color.map((v) => (v - min) * scale) as RGB
}

/** `colorBurn(cb, cs)` — the sharper of the two darkening formulas. */
export function colorBurn(cb: number, cs: number): number {
  return cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs)
}

export function colorDodge(cb: number, cs: number): number {
  return cs >= 1 ? 1 : Math.min(1, cb / (1 - cs))
}

export function hardLight(cb: number, cs: number): number {
  return cs <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs)
}

export function softLight(cb: number, cs: number): number {
  if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb)
  const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb)
  return cb + (2 * cs - 1) * (d - cb)
}

export function vividLight(cb: number, cs: number): number {
  return cs <= 0.5 ? colorBurn(cb, 2 * cs) : colorDodge(cb, 2 * cs - 1)
}

/** One channel of the separable modes. The non-separable four go through [`blendRgb`]. */
export function blendChannel(mode: BlendModeName, cb: number, cs: number): number {
  switch (mode) {
    case 'Normal':
      return cs
    case 'Darken':
      return Math.min(cb, cs)
    case 'Multiply':
      return cb * cs
    case 'Color Burn':
      return colorBurn(cb, cs)
    case 'Linear Burn':
      return cb + cs - 1
    case 'Lighten':
      return Math.max(cb, cs)
    case 'Screen':
      return cb + cs - cb * cs
    case 'Color Dodge':
      return colorDodge(cb, cs)
    case 'Linear Dodge (Add)':
      return cb + cs
    case 'Overlay':
      return hardLight(cs, cb)
    case 'Soft Light':
      return softLight(cb, cs)
    case 'Hard Light':
      return hardLight(cb, cs)
    case 'Vivid Light':
      return vividLight(cb, cs)
    case 'Linear Light':
      return cb + 2 * cs - 1
    case 'Pin Light':
      return cs <= 0.5 ? Math.min(cb, 2 * cs) : Math.max(cb, 2 * cs - 1)
    case 'Hard Mix':
      // Linear Light, posterized to one bit.
      return cb + 2 * cs - 1 >= 0.5 ? 1 : 0
    case 'Difference':
      return Math.abs(cb - cs)
    case 'Exclusion':
      return cb + cs - 2 * cb * cs
    case 'Subtract':
      return cb - cs
    case 'Divide':
      return cs <= 0 ? 1 : cb / cs
    default:
      throw new Error(`${mode} is not a separable blend mode`)
  }
}

/** The blend function `B(Cb, Cs)`, unclamped as the spec defines it. */
export function blendRgb(mode: BlendModeName, cb: RGB, cs: RGB): RGB {
  if (!NON_SEPARABLE.has(mode)) {
    return [
      blendChannel(mode, cb[0], cs[0]),
      blendChannel(mode, cb[1], cs[1]),
      blendChannel(mode, cb[2], cs[2]),
    ]
  }
  switch (mode) {
    case 'Hue':
      return setLuminance(setSaturation(cs, saturation(cb)), luminance(cb))
    case 'Saturation':
      return setLuminance(setSaturation(cb, saturation(cs)), luminance(cb))
    case 'Color':
      return setLuminance(cs, luminance(cb))
    case 'Luminosity':
      return setLuminance(cb, luminance(cs))
    default:
      throw new Error(`${mode} is not a non-separable blend mode`)
  }
}

export type RGBA = [number, number, number, number]

/**
 * Composites `source` over `backdrop`, both un-premultiplied, with the W3C source-over-with-blend
 * formula. `opacity` is the layer's effective opacity (its own times every folder above it).
 */
export function compositePixel(
  backdrop: RGBA,
  source: RGBA,
  mode: BlendModeName,
  opacity: number,
): RGBA {
  const as = source[3] * opacity
  const ab = backdrop[3]
  if (as <= 0) return backdrop

  const cs: RGB = [source[0], source[1], source[2]]
  const cb: RGB = ab > 0 ? [backdrop[0], backdrop[1], backdrop[2]] : [0, 0, 0]
  const blended = blendRgb(mode, cb, cs)

  const ao = as + ab * (1 - as)
  if (ao <= 0) return [0, 0, 0, 0]

  const out: RGB = [0, 0, 0]
  for (let i = 0; i < 3; i += 1) {
    const co = as * (1 - ab) * cs[i] + as * ab * blended[i] + (1 - as) * ab * cb[i]
    out[i] = Math.min(1, Math.max(0, co / ao))
  }
  return [out[0], out[1], out[2], ao]
}
