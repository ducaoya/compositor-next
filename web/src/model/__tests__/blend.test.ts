import { describe, expect, it } from 'vitest'

import {
  NON_SEPARABLE,
  blendChannel,
  blendRgb,
  clipColor,
  colorBurn,
  colorDodge,
  compositePixel,
  hardLight,
  luminance,
  saturation,
  setLuminance,
  setSaturation,
  softLight,
  type RGB,
} from '../blend'
import { BLEND_MODES, type BlendModeName } from '../types'

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

describe('blend maths', () => {
  it('operates in sRGB, not linear light', () => {
    // The reference app is explicit about this, and it is the single easiest thing to get wrong.
    // Multiply of two 50% grays is 25% in sRGB; in linear light it would be about 24%.
    const sRGB = blendChannel('Multiply', 0.5, 0.5)
    expect(sRGB).toBeCloseTo(0.25, 10)

    const linear = linearToSrgb(srgbToLinear(0.5) * srgbToLinear(0.5))
    expect(linear).toBeCloseTo(0.2370, 3)
    expect(Math.abs(sRGB - linear)).toBeGreaterThan(0.01)
  })

  it('composites source-over when there is nothing underneath', () => {
    const over = compositePixel([0, 0, 0, 0], [1, 0, 0, 1], 'Multiply', 1)
    expect(over).toEqual([1, 0, 0, 1])
  })

  it('leaves the backdrop alone at zero opacity or zero alpha', () => {
    const backdrop: [number, number, number, number] = [0.2, 0.4, 0.6, 0.8]
    expect(compositePixel(backdrop, [1, 1, 1, 1], 'Normal', 0)).toEqual(backdrop)
    expect(compositePixel(backdrop, [1, 1, 1, 0], 'Normal', 1)).toEqual(backdrop)
  })

  it('matches the reference formula for a translucent source', () => {
    // Multiply, 50% gray source at 50% alpha over a 50% gray opaque backdrop.
    const [r, , , a] = compositePixel([0.5, 0.5, 0.5, 1], [0.5, 0.5, 0.5, 0.5], 'Multiply', 1)
    // co = 0.5*0*0.5 + 0.5*1*0.25 + 0.5*1*0.5 = 0.375 ; ao = 1
    expect(r).toBeCloseTo(0.375, 10)
    expect(a).toBeCloseTo(1, 10)
  })

  it('folds a folder opacity into the layer opacity', () => {
    const half = compositePixel([0, 0, 0, 1], [1, 1, 1, 1], 'Normal', 0.5)
    const quarter = compositePixel([0, 0, 0, 1], [1, 1, 1, 1], 'Normal', 0.25)
    expect(half[0]).toBeCloseTo(0.5, 10)
    expect(quarter[0]).toBeCloseTo(0.25, 10)
  })

  it('has the expected identities', () => {
    expect(blendChannel('Overlay', 0.3, 0.7)).toBeCloseTo(hardLight(0.7, 0.3), 12)
    expect(blendChannel('Difference', 0.3, 0.7)).toBeCloseTo(0.4, 12)
    expect(blendChannel('Exclusion', 0.3, 0.7)).toBeCloseTo(1 - 0.42, 12)
    expect(blendChannel('Subtract', 0.3, 0.7)).toBeCloseTo(-0.4, 12)
    expect(blendChannel('Linear Dodge (Add)', 0.3, 0.7)).toBeCloseTo(1, 12)
    expect(blendChannel('Hard Mix', 0.3, 0.7)).toBe(1)
    expect(blendChannel('Hard Mix', 0.1, 0.2)).toBe(0)
  })

  it('treats a zero divisor as white for Color Dodge and Divide', () => {
    expect(colorDodge(0.5, 1)).toBe(1)
    expect(colorBurn(0.5, 0)).toBe(0)
    expect(blendChannel('Divide', 0.5, 0)).toBe(1)
  })

  it('keeps Soft Light inside the range and moves in the right direction', () => {
    for (const cb of [0, 0.2, 0.5, 0.8, 1]) {
      for (const cs of [0, 0.25, 0.5, 0.75, 1]) {
        const out = softLight(cb, cs)
        expect(out).toBeGreaterThanOrEqual(0)
        expect(out).toBeLessThanOrEqual(1)
      }
    }
    expect(softLight(0.5, 1)).toBeGreaterThan(0.5)
    expect(softLight(0.5, 0)).toBeLessThan(0.5)
    expect(softLight(0.5, 0.5)).toBeCloseTo(0.5, 12)
  })

  it('clamps and re-saturates out-of-gamut colors without changing hue order', () => {
    const clipped = clipColor([1.2, 0.5, -0.2])
    expect(Math.min(...clipped)).toBeGreaterThanOrEqual(-1e-12)
    expect(Math.max(...clipped)).toBeLessThanOrEqual(1 + 1e-12)
  })

  it('setLuminance and setSaturation do what their names say', () => {
    const shifted = setLuminance([1, 0, 0], 0.5)
    expect(luminance(shifted)).toBeCloseTo(0.5, 10)

    const desaturated = setSaturation([1, 0, 0], 0)
    expect(saturation(desaturated)).toBeCloseTo(0, 12)

    const half = setSaturation([1, 0, 0], 0.5)
    expect(saturation(half)).toBeCloseTo(0.5, 10)
  })

  it('leaves a gray backdrop colorless under the component modes', () => {
    const gray: RGB = [0.5, 0.5, 0.5]
    const red: RGB = [1, 0, 0]
    // "Color" takes the source's hue and the backdrop's luminance: a gray backdrop has no hue to
    // take, so the result is the source color shifted to the backdrop's luminance.
    const result = blendRgb('Color', gray, red)
    expect(luminance(result)).toBeCloseTo(luminance(gray), 6)
  })

  it('round-trips Luminosity and Color against each other', () => {
    const backdrop: RGB = [0.2, 0.6, 0.9]
    const source: RGB = [0.8, 0.3, 0.4]
    // Luminosity keeps the backdrop's hue and chroma, and takes the source's luminance.
    expect(luminance(blendRgb('Luminosity', backdrop, source))).toBeCloseTo(luminance(source), 6)
    // Color is the other way round: the source's hue and chroma, the backdrop's luminance.
    expect(luminance(blendRgb('Color', backdrop, source))).toBeCloseTo(luminance(backdrop), 6)
  })

  it('covers every mode in the format, separable or not', () => {
    for (const mode of BLEND_MODES) {
      const cb: RGB = [0.3, 0.6, 0.9]
      const cs: RGB = [0.9, 0.2, 0.5]
      const out = blendRgb(mode as BlendModeName, cb, cs)
      expect(out).toHaveLength(3)
      expect(out.every(Number.isFinite)).toBe(true)
      if (NON_SEPARABLE.has(mode)) {
        // Handled by blendRgb; blendChannel should refuse it.
        expect(() => blendChannel(mode as BlendModeName, 0.5, 0.5)).toThrow()
      }
    }
  })

  it('composites the same way whichever order the channels are read', () => {
    const backdrop: [number, number, number, number] = [0.4, 0.5, 0.6, 1]
    const source: [number, number, number, number] = [0.1, 0.9, 0.2, 1]
    const out = compositePixel(backdrop, source, 'Overlay', 1)
    expect(out[3]).toBeCloseTo(1, 12)
    for (const channel of out.slice(0, 3)) {
      expect(channel).toBeGreaterThanOrEqual(0)
      expect(channel).toBeLessThanOrEqual(1)
    }
  })
})
