import { describe, expect, it } from 'vitest'

import {
  DEFAULT_BANDS,
  bandWeight,
  bandIsOrdered,
  buildHueResponse,
  buildLut,
  COLOR_RANGES,
  forward,
  identityAdjustment,
  masterValues,
  movedBandEdge,
  packAdjustment,
  rangeValues,
  resolvedBand,
  withBand,
  withRangeValues,
  type LayerAdjustment,
} from '../adjustments'

/**
 * Unpacks a response entry the way the shader does.
 *
 * This is the other half of `packResponseByte`: a drift between the two is what made every canvas
 * with a Hue/Saturation layer go black, so the arithmetic here is deliberately the shader's.
 */
function responseAt(table: Uint8Array, hue: number): { shift: number; saturation: number; lightness: number } {
  const at = (hue % 360) * 4
  return {
    shift: (table[at] - 128) * (180 / 127),
    saturation: (table[at + 1] - 128) * (100 / 127),
    lightness: (table[at + 2] - 128) * (100 / 127),
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
   * The encoding is centred on 128 precisely so that this is exact rather than nearly exact: a
   * neutral entry used to decode to a 0.7-degree rotation and a point of saturation, which shifted
   * every pixel of an untouched hue by a byte.
   */
  it('is exactly nothing when nothing was asked for', () => {
    const table = buildHueResponse(identityAdjustment('Hue/Saturation'))
    for (let hue = 0; hue < 360; hue += 1) {
      const entry = responseAt(table, hue)
      expect(entry.shift).toBe(0)
      expect(entry.saturation).toBe(0)
      expect(entry.lightness).toBe(0)
    }
  })

  it('leaves an unclaimed hue exactly neutral while a claimed one moves', () => {
    const table = buildHueResponse(withBands({ blues: { hue: 60 } }))
    // Reds are nowhere near the blues band, so their entry has to be the neutral byte itself.
    expect(table[0]).toBe(128)
    expect(table[1]).toBe(128)
    expect(table[2]).toBe(128)
    // The middle of the blues, on the other hand, has to move.
    expect(responseAt(table, 240).shift).toBeGreaterThan(55)
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
    expect(Math.abs(responseAt(table, 240).shift - 30)).toBeLessThan(1.0)
    expect(responseAt(table, 60).shift).toBe(0)
  })

  it('fades a range in and out rather than stepping at its edge', () => {
    const table = buildHueResponse(withBands({ blues: { hue: 100 } }))
    const core = responseAt(table, 240).shift
    const shoulder = responseAt(table, 210).shift
    const outside = responseAt(table, 300).shift
    expect(Math.abs(core - 100)).toBeLessThan(1.0)
    expect(shoulder).toBeGreaterThan(10)
    expect(shoulder).toBeLessThan(core)
    expect(outside).toBe(0)
  })

  it('adds ranges where their falloffs overlap', () => {
    // Blues run 195…285 and cyans 135…225, so 210 sits on both falloffs — half of each.
    const apart = buildHueResponse(withBands({ blues: { lightness: 100 } }))
    const together = buildHueResponse(withBands({ blues: { lightness: 50 }, cyans: { lightness: 50 } }))
    expect(Math.abs(responseAt(apart, 240).lightness - 100)).toBeLessThan(1.0)
    expect(Math.abs(responseAt(together, 210).lightness - 50)).toBeLessThan(1.0)
  })

  it('leaves the two sliders a range did not set alone', () => {
    // A range written as `{ hue: 60 }` holds `undefined` for saturation and lightness. Multiplying
    // that by the weight made the entry NaN, which packs to byte 0, which the shader decodes as
    // -100 — so a hue-only shift also wiped out saturation and lightness and rendered black.
    const table = buildHueResponse(withBands({ magentas: { hue: 60 } }))
    const entry = responseAt(table, 300)
    expect(Math.abs(entry.shift - 60)).toBeLessThan(1.0)
    expect(entry.saturation).toBe(0)
    expect(entry.lightness).toBe(0)
    // And the raw bytes are the neutral 128 rather than the 0 a NaN becomes.
    expect([...table.subarray(300 * 4, 300 * 4 + 3)]).toEqual([170, 128, 128])
  })

  it('packs a full-strength value without overflowing its byte', () => {
    const table = buildHueResponse(withBands({ master: { hue: 180, saturation: 100, lightness: 100 } }))
    const entry = responseAt(table, 0)
    expect(Math.abs(entry.shift - 180)).toBeLessThan(1.5)
    expect(Math.abs(entry.saturation - 100)).toBeLessThan(0.8)
    expect(Math.abs(entry.lightness - 100)).toBeLessThan(0.8)
  })

  it('packs the negative full scale as well as the positive', () => {
    const table = buildHueResponse(withBands({ master: { hue: -180, saturation: -100, lightness: -100 } }))
    const entry = responseAt(table, 0)
    expect(entry.shift).toBeLessThan(-179)
    expect(entry.saturation).toBeLessThanOrEqual(-100)
    expect(entry.lightness).toBeLessThanOrEqual(-100)
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

describe('the per-range values the panel writes', () => {
  it('defaults everything a range did not set, rather than leaving it undefined', () => {
    // The shape a slider produces: one field set, two absent. `undefined` reaching the table is what
    // made the band render black, so this is the assertion that stands between the two.
    const adjustment = withBands({ magentas: { hue: 60 } })
    const values = rangeValues(adjustment, 'magentas')
    expect(values).toEqual({ hue: 60, saturation: 0, lightness: 0 })
  })

  it('reads an older file\'s master from the flat fields, and a newer one from `adjustments`', () => {
    const legacy = identityAdjustment('Hue/Saturation')
    legacy.hsvSettings = { hue: 30, saturation: 20, lightness: -10, colorize: false }
    expect(masterValues(legacy)).toEqual({ hue: 30, saturation: 20, lightness: -10 })

    const modern = identityAdjustment('Hue/Saturation')
    modern.hsvSettings = {
      hue: 0,
      saturation: 0,
      lightness: 0,
      colorize: false,
      adjustments: { master: { hue: -40, saturation: 5, lightness: 0 } },
    }
    expect(masterValues(modern)).toEqual({ hue: -40, saturation: 5, lightness: 0 })
  })

  it('keeps the master applying alongside a range, the way Photoshop does', () => {
    // Both are in the table: the master claims every hue and the band claims its own, so a pixel in
    // the band sees the sum. Replacing the master with the bands instead was how a master setting
    // came to be silently ignored.
    const adjustment = identityAdjustment('Hue/Saturation')
    adjustment.saturation = 50
    adjustment.hsvSettings = {
      hue: 0,
      saturation: 50,
      lightness: 0,
      colorize: false,
      adjustments: { greens: { hue: 30 } },
    }
    const table = buildHueResponse(adjustment)
    // A green is in the band: hue moves and the master's saturation is there too.
    expect(Math.abs(responseAt(table, 120).shift - 30)).toBeLessThan(1.5)
    expect(Math.abs(responseAt(table, 120).saturation - 50)).toBeLessThan(1.0)
    // A magenta is outside it: the master's saturation still applies, the band's hue does not.
    expect(responseAt(table, 300).shift).toBe(0)
    expect(Math.abs(responseAt(table, 300).saturation - 50)).toBeLessThan(1.0)
  })

  it('changes one range and leaves the other six exactly where they were', () => {
    const before = identityAdjustment('Hue/Saturation')
    before.hsvSettings = withRangeValues(before, 'blues', { hue: 60 })
    const after = withRangeValues(before, 'reds', { saturation: -30, hue: 0, lightness: 0 })
    expect(after.adjustments?.blues).toEqual({ hue: 60 })
    expect(after.adjustments?.reds).toEqual({ hue: 0, saturation: -30, lightness: 0 })
    expect(after.adjustments?.greens).toBeUndefined()
    // And the master's own fields are untouched by a band write.
    expect(after.hue).toBe(0)
    expect(after.colorize).toBe(false)
  })

  it('changes one band and leaves the other six alone', () => {
    const adjustment = identityAdjustment('Hue/Saturation')
    const moved = withBand(adjustment, 'greens', { falloffStart: 90, rangeStart: 100, rangeEnd: 140, falloffEnd: 180 })
    expect(resolvedBand({ ...adjustment, hsvSettings: moved }, 'greens')).toEqual({
      falloffStart: 90,
      rangeStart: 100,
      rangeEnd: 140,
      falloffEnd: 180,
    })
    // Everything the project did not move is still Photoshop's starting band.
    expect(resolvedBand({ ...adjustment, hsvSettings: moved }, 'blues')).toEqual(DEFAULT_BANDS.blues)
    expect(moved.bands?.blues).toBeUndefined()
  })

  it('reads a band as a forward walk, because reds straddle zero', () => {
    // 315, 345, 15, 45 is in order and does not look it: the four are ordered by how far each is
    // from the falloff start going forwards, which is the walk `bandWeight` makes.
    expect(bandIsOrdered(DEFAULT_BANDS.reds)).toBe(true)
    expect(bandIsOrdered(DEFAULT_BANDS.master)).toBe(true)
    for (const range of COLOR_RANGES) expect(bandIsOrdered(DEFAULT_BANDS[range])).toBe(true)
    // Crossing a neighbour is not.
    expect(bandIsOrdered({ ...DEFAULT_BANDS.greens, rangeEnd: 95 })).toBe(false)
    // 340 sits behind the reds' range start of 345, which is crossing even though it is a bigger number.
    expect(bandIsOrdered({ ...DEFAULT_BANDS.reds, rangeEnd: 340 })).toBe(false)
  })

  it('keeps a moved edge in order instead of leaving a band that claims nothing', () => {
    // The blues run 195…285. Pulling the falloff start past the range end lands on the nearest
    // value that does not cross it.
    const pulled = movedBandEdge(DEFAULT_BANDS.blues, 'falloffStart', 340)
    expect(bandIsOrdered(pulled)).toBe(true)
    expect(pulled.rangeStart).toBe(DEFAULT_BANDS.blues.rangeStart)
    expect(pulled.rangeEnd).toBe(DEFAULT_BANDS.blues.rangeEnd)
    expect(pulled.falloffEnd).toBe(DEFAULT_BANDS.blues.falloffEnd)

    // And the same from the other side: a range end typed before its start.
    const squeezed = movedBandEdge(DEFAULT_BANDS.greens, 'rangeEnd', 20)
    expect(bandIsOrdered(squeezed)).toBe(true)
    expect(squeezed.falloffStart).toBe(DEFAULT_BANDS.greens.falloffStart)

    // An ordinary move is taken exactly, rounded to a degree.
    expect(movedBandEdge(DEFAULT_BANDS.blues, 'rangeStart', 230.4).rangeStart).toBe(230)
  })

  it('gives the shader the master wherever the panel put it', () => {
    // The colorize path reads the master from the uniform, so a panel that writes
    // `adjustments.master` has to reach it — otherwise Colorize would apply nothing.
    const adjustment = identityAdjustment('Hue/Saturation')
    adjustment.hsvSettings = {
      hue: 0,
      saturation: 0,
      lightness: 0,
      colorize: true,
      adjustments: { master: { hue: 45, saturation: 20, lightness: -5 } },
    }
    const packed = packAdjustment(adjustment, 1, 10, 10)
    expect([packed[8], packed[9], packed[10]]).toEqual([45, 20, -5])
  })
})
