import { describe, expect, it } from 'vitest'

import {
  DEFAULT_BANDS,
  bandWeight,
  buildHueResponse,
  buildLut,
  COLOR_RANGES,
  forward,
  identityAdjustment,
  type LayerAdjustment,
} from '../adjustments'

/** Unpacks a response entry the way the shader does. */
function responseAt(table: Uint8Array, hue: number): { shift: number; saturation: number; lightness: number } {
  const at = (hue % 360) * 4
  return {
    shift: (table[at] / 255) * 360 - 180,
    saturation: (table[at + 1] / 255) * 200 - 100,
    lightness: (table[at + 2] / 255) * 200 - 100,
  }
}

function withBands(adjustments: Partial<Record<string, { hue?: number; saturation?: number; lightness?: number }>>): LayerAdjustment {
  const adjustment = identityAdjustment('Hue/Saturation')
  adjustment.hsvSettings = {
    hue: 0,
    saturation: 0,
    lightness: 0,
    colorize: false,
    adjustments: adjustments as never,
  }
  return adjustment
}

describe('degrees forward along the wheel', () => {
  it('wraps rather than going negative', () => {
    expect(forward(0, 90)).toBe(90)
    expect(forward(350, 10)).toBe(20)
    expect(forward(10, 350)).toBe(340)
  })
})

describe('a colour band', () => {
  it('claims its own core completely', () => {
    expect(bandWeight(DEFAULT_BANDS.reds, 0)).toBe(1)
    expect(bandWeight(DEFAULT_BANDS.yellows, 60)).toBe(1)
    expect(bandWeight(DEFAULT_BANDS.blues, 240)).toBe(1)
  })

  it('claims nothing outside its falloffs', () => {
    // Reds run 315…45; 200 degrees away is not red at all.
    expect(bandWeight(DEFAULT_BANDS.reds, 200)).toBe(0)
    expect(bandWeight(DEFAULT_BANDS.yellows, 300)).toBe(0)
  })

  it('ramps across the falloff instead of switching at a threshold', () => {
    // Reds fall off from 315 to 345, so 330 is halfway up the ramp.
    expect(bandWeight(DEFAULT_BANDS.reds, 330)).toBeCloseTo(0.5, 2)
    // And down the other side, from 15 to 45.
    expect(bandWeight(DEFAULT_BANDS.reds, 30)).toBeCloseTo(0.5, 2)
  })

  it('wraps, so reds straddling zero behave like the others', () => {
    expect(bandWeight(DEFAULT_BANDS.reds, 359)).toBe(1)
    expect(bandWeight(DEFAULT_BANDS.reds, 0)).toBe(1)
    expect(bandWeight(DEFAULT_BANDS.reds, 5)).toBe(1)
  })

  it('has a master that claims everything, which is what makes it the master', () => {
    for (const hue of [0, 45, 180, 270, 359]) {
      expect(bandWeight(DEFAULT_BANDS.master, hue)).toBe(1)
    }
  })

  it('tiles the wheel: every hue is claimed by something', () => {
    for (let hue = 0; hue < 360; hue += 1) {
      const claimed = COLOR_RANGES.filter((range) => bandWeight(DEFAULT_BANDS[range], hue) > 0)
      expect(claimed.length).toBeGreaterThan(0)
    }
  })
})

describe('the response table', () => {
  it('is one entry per degree of hue', () => {
    expect(buildHueResponse(identityAdjustment('Hue/Saturation'))).toHaveLength(360 * 4)
  })

  /**
   * A byte holds the shift's 360-degree range in 1.41-degree steps, and the other two in 0.78,
   * so "nothing" comes back as a fraction of a degree rather than exactly zero. That is the
   * quantisation the format's own byte packing costs, and it is well under a degree.
   */
  it('is empty when nothing was asked for', () => {
    const table = buildHueResponse(identityAdjustment('Hue/Saturation'))
    for (let hue = 0; hue < 360; hue += 1) {
      const entry = responseAt(table, hue)
      expect(Math.abs(entry.shift)).toBeLessThan(1.5)
      expect(Math.abs(entry.saturation)).toBeLessThan(0.8)
      expect(Math.abs(entry.lightness)).toBeLessThan(0.8)
    }
  })

  it('applies a master adjustment to every hue alike', () => {
    const adjustment = identityAdjustment('Hue/Saturation')
    adjustment.saturation = 40
    const table = buildHueResponse(adjustment)
    for (const hue of [0, 90, 180, 270]) {
      expect(Math.abs(responseAt(table, hue).saturation - 40)).toBeLessThan(0.8)
    }
  })

  /** The whole point of the bands: one family of colours moves and the rest do not. */
  it('moves only the colours a range was given', () => {
    const table = buildHueResponse(withBands({ blues: { hue: 30 } }))
    // 240 is the middle of the blues; 60 is the middle of the yellows.
    expect(Math.abs(responseAt(table, 240).shift - 30)).toBeLessThan(1.5)
    expect(Math.abs(responseAt(table, 60).shift)).toBeLessThan(1.5)
  })

  it('fades a range in and out rather than stepping at its edge', () => {
    const table = buildHueResponse(withBands({ blues: { hue: 100 } }))
    const core = responseAt(table, 240).shift
    const shoulder = responseAt(table, 210).shift
    const outside = responseAt(table, 300).shift
    expect(Math.abs(core - 100)).toBeLessThan(1.5)
    expect(shoulder).toBeGreaterThan(10)
    expect(shoulder).toBeLessThan(core)
    expect(Math.abs(outside)).toBeLessThan(1.5)
  })

  it('adds ranges where their falloffs overlap', () => {
    // Blues run 195…285 and cyans 135…225, so 210 sits on both falloffs — half of each.
    const apart = buildHueResponse(withBands({ blues: { lightness: 100 } }))
    const together = buildHueResponse(withBands({ blues: { lightness: 50 }, cyans: { lightness: 50 } }))
    expect(Math.abs(responseAt(apart, 240).lightness - 100)).toBeLessThan(0.8)
    expect(Math.abs(responseAt(together, 210).lightness - 50)).toBeLessThan(1.5)
  })

  it('packs a full-strength value without overflowing its byte', () => {
    const table = buildHueResponse(withBands({ master: { hue: 180, saturation: 100, lightness: 100 } }))
    const entry = responseAt(table, 0)
    expect(Math.abs(entry.shift - 180)).toBeLessThan(1.5)
    expect(Math.abs(entry.saturation - 100)).toBeLessThan(0.8)
    expect(Math.abs(entry.lightness - 100)).toBeLessThan(0.8)
  })
})

describe('which adjustments carry a table', () => {
  it('gives Hue/Saturation a response and Levels a curve', () => {
    expect(buildLut(identityAdjustment('Hue/Saturation'))).toHaveLength(360 * 4)
    expect(buildLut(identityAdjustment('Levels'))).toHaveLength(256 * 3)
    expect(buildLut(identityAdjustment('Invert'))).toHaveLength(256 * 3)
  })

  it('gives the kinds that compute in the shader nothing at all', () => {
    for (const kind of ['Gradient Map', 'Color Balance', 'Black & White', 'Grain', 'Gaussian Blur'] as const) {
      expect(buildLut(identityAdjustment(kind))).toBeNull()
    }
  })
})
