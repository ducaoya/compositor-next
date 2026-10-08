import { describe, expect, it } from 'vitest'

import {
  ADJUSTMENT_KINDS,
  ADJUST_UNIFORM_VECS,
  adjustmentKindIndex,
  adjustmentKindKey,
  buildLut,
  curveValue,
  identityAdjustment,
  packAdjustment,
  resolvedBlackWhite,
  resolvedLevels,
  type LayerAdjustment,
} from '../adjustments'

function withLevels(range: Partial<{ black: number; gamma: number; white: number; outputBlack: number; outputWhite: number }>): LayerAdjustment {
  const adjustment = identityAdjustment('Levels')
  adjustment.levels = {
    channel: 'RGB',
    ranges: [{ black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 }, ...Array.from({ length: 3 }, () => ({
      black: 0,
      gamma: 1,
      white: 255,
      outputBlack: 0,
      outputWhite: 255,
    }))],
  }
  adjustment.levels.ranges[0] = { ...adjustment.levels.ranges[0], ...range }
  return adjustment
}

describe('the adjustment kinds', () => {
  it('lists all twelve, in the order the shader numbers them', () => {
    expect(ADJUSTMENT_KINDS).toEqual([
      'Hue/Saturation',
      'Levels',
      'Curves',
      'Exposure',
      'Gradient Map',
      'Grain',
      'Invert',
      'Black & White',
      'Color Balance',
      'Gaussian Blur',
      'Motion Blur',
      'Add Noise',
    ])
    for (const [index, kind] of ADJUSTMENT_KINDS.entries()) {
      expect(adjustmentKindIndex(kind)).toBe(index)
    }
  })

  it('slugs a kind into a key vue-i18n accepts', () => {
    expect(adjustmentKindKey('Hue/Saturation')).toBe('adjust.kinds.hue-saturation')
    expect(adjustmentKindKey('Black & White')).toBe('adjust.kinds.black-white')
    expect(adjustmentKindKey('Gaussian Blur')).toBe('adjust.kinds.gaussian-blur')
    for (const kind of ADJUSTMENT_KINDS) {
      expect(adjustmentKindKey(kind)).toMatch(/^[a-zA-Z0-9.-]+$/)
    }
  })

  it('gives every kind an identity it can start from', () => {
    for (const kind of ADJUSTMENT_KINDS) {
      const adjustment = identityAdjustment(kind)
      expect(adjustment.kind).toBe(kind)
      // Levels and Curves are written for every kind, as the format expects.
      expect(adjustment.levels.ranges).toHaveLength(4)
      expect(adjustment.curves.channels).toHaveLength(4)
      const lut = buildLut(adjustment)
      if (lut) {
        // Levels, Curves and Exposure start as the identity. Invert does not: its cheapest
        // starting point is a full inversion, which the test below pins. Hue/Saturation carries a
        // hue response rather than a per-channel curve, which hueBands.test.ts covers.
        if (kind === 'Invert' || kind === 'Hue/Saturation') continue
        for (let value = 0; value < 256; value += 1) {
          expect(lut[value]).toBe(value)
          expect(lut[256 + value]).toBe(value)
          expect(lut[512 + value]).toBe(value)
        }
      }
    }
  })

  it('only builds a table for the kinds that are one', () => {
    expect(buildLut(identityAdjustment('Levels'))).not.toBeNull()
    expect(buildLut(identityAdjustment('Curves'))).not.toBeNull()
    expect(buildLut(identityAdjustment('Exposure'))).not.toBeNull()
    expect(buildLut(identityAdjustment('Invert'))).not.toBeNull()
    // Hue/Saturation is a table too, but of hue response rather than per-channel output.
    expect(buildLut(identityAdjustment('Hue/Saturation'))).toHaveLength(360 * 4)
    expect(buildLut(identityAdjustment('Color Balance'))).toBeNull()
    expect(buildLut(identityAdjustment('Gaussian Blur'))).toBeNull()
  })
})

describe('levels', () => {
  it('maps the black and white points to the output ends', () => {
    const lut = buildLut(withLevels({ black: 50, white: 200 }))!
    expect(lut[50]).toBe(0)
    expect(lut[200]).toBe(255)
    expect(lut[0]).toBe(0)
    expect(lut[255]).toBe(255)
    // The midpoint of 50…200 lands halfway.
    expect(lut[125]).toBeGreaterThanOrEqual(126)
    expect(lut[125]).toBeLessThanOrEqual(128)
  })

  it('honours the output range', () => {
    const lut = buildLut(withLevels({ outputBlack: 50, outputWhite: 200 }))!
    expect(lut[0]).toBe(50)
    expect(lut[255]).toBe(200)
  })

  it('reads a range back with its defaults filled in', () => {
    const adjustment = identityAdjustment('Levels')
    adjustment.levels = { channel: 'RGB', ranges: [{ black: 10, gamma: 1.2, white: 240, outputBlack: 5, outputWhite: 250 }] }
    const ranges = resolvedLevels(adjustment)
    expect(ranges).toHaveLength(4)
    expect(ranges[0]).toEqual({ black: 10, gamma: 1.2, white: 240, outputBlack: 5, outputWhite: 250 })
    expect(ranges[1]).toEqual({ black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 })
  })
})

describe('invert', () => {
  it('is 255 minus the value', () => {
    const lut = buildLut(identityAdjustment('Invert'))!
    for (const value of [0, 1, 64, 128, 200, 254, 255]) {
      expect(lut[value]).toBe(255 - value)
    }
  })
})

describe('curves', () => {
  const identity = [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ]

  it('is the identity through the two default points', () => {
    for (const x of [0, 32, 128, 200, 255]) {
      expect(curveValue(x, identity)).toBeCloseTo(x, 6)
    }
  })

  it('passes through every point it is given', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 100, y: 140 },
      { x: 200, y: 210 },
      { x: 255, y: 255 },
    ]
    for (const point of points) {
      expect(curveValue(point.x, points)).toBeCloseTo(point.y, 4)
    }
  })

  /** Shape-preserving means a curve never overshoots between two handles, which is the whole point. */
  it('does not overshoot between handles', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 60, y: 5 },
      { x: 200, y: 250 },
      { x: 255, y: 255 },
    ]
    for (let x = 0; x <= 255; x += 1) {
      const y = curveValue(x, points)
      expect(y).toBeGreaterThanOrEqual(-1e-6)
      expect(y).toBeLessThanOrEqual(255 + 1e-6)
    }
  })

  it('bakes into a table, composite channel first', () => {
    const adjustment = identityAdjustment('Curves')
    adjustment.curves = {
      channel: 'RGB',
      channels: [
        [
          { x: 0, y: 0 },
          { x: 128, y: 200 },
          { x: 255, y: 255 },
        ],
        identity,
        identity,
        identity,
      ],
    }
    const lut = buildLut(adjustment)!
    // The composite curve lifts the midtones, and every channel follows it.
    expect(lut[128]).toBeGreaterThan(150)
    expect(lut[256 + 128]).toBe(lut[128])
    expect(lut[512 + 128]).toBe(lut[128])
    expect(lut[0]).toBe(0)
    expect(lut[255]).toBe(255)
  })
})

describe('the shader uniform', () => {
  it('is the size the WGSL declares', () => {
    const packed = packAdjustment(identityAdjustment('Levels'), 1, 100, 50)
    expect(packed).toHaveLength(ADJUST_UNIFORM_VECS * 4)
    const words = new Uint32Array(packed.buffer)
    void words
  })

  it('carries the kind index, the opacity and the canvas size', () => {
    for (const kind of ADJUSTMENT_KINDS) {
      const packed = packAdjustment(identityAdjustment(kind), 0.5, 120, 80)
      expect(packed[0]).toBe(adjustmentKindIndex(kind))
      expect(packed[1]).toBeCloseTo(0.5, 6)
      expect(packed[2]).toBe(120)
      expect(packed[3]).toBe(80)
    }
  })

  it('puts the blur radius in the slot the blur pass reads', () => {
    const gaussian = identityAdjustment('Gaussian Blur')
    gaussian.blurRadius = 24
    const packed = packAdjustment(gaussian, 1, 10, 10, [1, 0])
    expect(packed[20]).toBe(24)
    expect(packed[21]).toBe(1)
    expect(packed[22]).toBe(0)

    const motion = identityAdjustment('Motion Blur')
    motion.motionDistance = 60
    const moved = packAdjustment(motion, 1, 10, 10, [0.5, -0.5])
    expect(moved[20]).toBe(60)
    expect(moved[21]).toBeCloseTo(0.5, 6)
    expect(moved[22]).toBeCloseTo(-0.5, 6)
  })

  it('marks whether a lookup table is used, and whether the layer has a mask', () => {
    expect(packAdjustment(identityAdjustment('Levels'), 1, 10, 10)[23]).toBe(1)
    expect(packAdjustment(identityAdjustment('Grain'), 1, 10, 10)[23]).toBe(0)
    expect(packAdjustment(identityAdjustment('Levels'), 1, 10, 10, [0, 0], true)[56]).toBe(1)
    expect(packAdjustment(identityAdjustment('Levels'), 1, 10, 10, [0, 0], false)[56]).toBe(0)
  })

  it('carries the Black & White weights in the reference order', () => {
    const adjustment = identityAdjustment('Black & White')
    const packed = packAdjustment(adjustment, 1, 10, 10)
    const bw = resolvedBlackWhite(adjustment)
    expect([packed[24], packed[25], packed[26], packed[27]]).toEqual([bw.reds, bw.yellows, bw.greens, bw.cyans])
    expect([packed[28], packed[29]]).toEqual([bw.blues, bw.magentas])
  })
})
