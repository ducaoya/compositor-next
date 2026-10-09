import { describe, expect, it } from 'vitest'

import { dither, type DitherSettings } from '../dither'
import type { Rgba } from '../types'

function field(width: number, height: number, value: number, alpha = 255): Rgba {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data[pixel * 4] = value
    data[pixel * 4 + 1] = value
    data[pixel * 4 + 2] = value
    data[pixel * 4 + 3] = alpha
  }
  return { data, width, height }
}

/** A left-to-right ramp, which is what shows whether an error is being carried along. */
function ramp(width: number, height: number): Rgba {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4
      const value = Math.round((x / (width - 1)) * 255)
      data[at] = value
      data[at + 1] = value
      data[at + 2] = value
      data[at + 3] = 255
    }
  }
  return { data, width, height }
}

function mean(pixels: Rgba, channel = 0): number {
  let total = 0
  let count = 0
  for (let at = 0; at < pixels.data.length; at += 4) {
    if (pixels.data[at + 3] === 0) continue
    total += pixels.data[at + channel]
    count += 1
  }
  return count === 0 ? 0 : total / count
}

function values(pixels: Rgba, channel = 0): Set<number> {
  const seen = new Set<number>()
  for (let at = 0; at < pixels.data.length; at += 4) seen.add(pixels.data[at + channel])
  return seen
}

const base: DitherSettings = {
  method: 'diffusion',
  levels: 2,
  amount: 100,
  serpentine: false,
  monochromatic: false,
  seed: 3,
}

describe('dithering to two levels', () => {
  it('leaves no channel at anything but the two ends', () => {
    for (const method of ['diffusion', 'pattern', 'noise'] as const) {
      for (const monochromatic of [false, true]) {
        const pixels = field(24, 24, 128)
        dither(pixels, { ...base, method, monochromatic })
        expect(values(pixels), `${method} ${monochromatic ? 'mono' : 'colour'}`).toEqual(
          new Set([0, 255]),
        )
      }
    }
  })

  it('keeps the average when it decides the whole pixel at once', () => {
    // The monochromatic path decides on luminance and writes one value to three channels, so its
    // error arithmetic is its own — and getting it wrong (handing on the pixel's own difference
    // rather than the error it had arrived with) turns the dither back into a threshold, which is a
    // thing a two-level test alone cannot see.
    for (const value of [41, 100, 200]) {
      const pixels = field(48, 48, value)
      dither(pixels, { ...base, monochromatic: true })
      const white = [...values(pixels)].length === 2 ? mean(pixels) / 255 : 0
      expect(white, `grey ${value}`).toBeGreaterThan(value / 255 - 0.08)
      expect(white, `grey ${value}`).toBeLessThan(value / 255 + 0.08)
    }
  })

  it('spreads the error in colour, channel by channel', () => {
    // A pixel whose channels want different things: each channel carries its own error, so the three
    // averages land where the three channels were rather than on one grey value.
    const pixels = field(48, 48, 0)
    for (let at = 0; at < pixels.data.length; at += 4) {
      pixels.data[at] = 200
      pixels.data[at + 1] = 90
      pixels.data[at + 2] = 30
    }
    dither(pixels, base)
    expect(mean(pixels, 0)).toBeGreaterThan(200 - 20)
    expect(mean(pixels, 0)).toBeLessThan(200 + 20)
    expect(mean(pixels, 1)).toBeGreaterThan(90 - 20)
    expect(mean(pixels, 1)).toBeLessThan(90 + 20)
    expect(mean(pixels, 2)).toBeGreaterThan(30 - 20)
    expect(mean(pixels, 2)).toBeLessThan(30 + 20)
  })

  it('carries the error, so a mid grey stays a mid grey', () => {
    // This is the whole reason to dither rather than threshold: 128 must not become 255 everywhere.
    const pixels = field(32, 32, 128)
    dither(pixels, base)
    expect(values(pixels)).toEqual(new Set([0, 255]))
    expect(mean(pixels)).toBeGreaterThan(100)
    expect(mean(pixels)).toBeLessThan(155)
  })

  it('is a threshold when nothing is carried', () => {
    // `amount` is how much of the error is passed on, so nothing passed on is the honest way to ask
    // for no dithering at all.
    const pixels = field(16, 16, 128)
    dither(pixels, { ...base, amount: 0 })
    expect(values(pixels)).toEqual(new Set([255]))
  })

  it('keeps the average of a ramp where the ramp was', () => {
    const before = ramp(64, 16)
    const after = ramp(64, 16)
    dither(after, base)
    expect(values(after)).toEqual(new Set([0, 255]))
    // A gradient dithered well reads as the gradient: the local average has to survive.
    expect(mean(after)).toBeGreaterThan(mean(before) - 12)
    expect(mean(after)).toBeLessThan(mean(before) + 12)
  })
})

describe('the three methods', () => {
  it('spreads the error differently, in a way that is stable for each', () => {
    const one = field(24, 24, 100)
    const two = field(24, 24, 100)
    dither(one, { ...base, method: 'diffusion' })
    dither(two, { ...base, method: 'pattern' })
    expect(one.data).not.toEqual(two.data)
  })

  it('repeats the pattern every eight pixels, because the matrix is eight by eight', () => {
    const pixels = field(16, 16, 128)
    dither(pixels, { ...base, method: 'pattern' })
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const here = pixels.data[(y * 16 + x) * 4]
        const far = pixels.data[((y + 8) * 16 + (x + 8)) * 4]
        expect(here, `at ${x},${y}`).toBe(far)
      }
    }
  })

  it('is grain rather than a texture for noise, and the same grain for the same seed', () => {
    const one = field(24, 24, 128)
    const two = field(24, 24, 128)
    const other = field(24, 24, 128)
    dither(one, { ...base, method: 'noise', seed: 11 })
    dither(two, { ...base, method: 'noise', seed: 11 })
    dither(other, { ...base, method: 'noise', seed: 12 })
    expect(one.data).toEqual(two.data)
    expect(one.data).not.toEqual(other.data)
  })

  it('lets serpentine change which way the error drifts, without changing the average', () => {
    const one = ramp(64, 32)
    const two = ramp(64, 32)
    dither(one, base)
    dither(two, { ...base, serpentine: true })
    expect(one.data).not.toEqual(two.data)
    expect(Math.abs(mean(one) - mean(two))).toBeLessThan(4)
  })
})

describe('levels, colour and alpha', () => {
  it('divides the range into as many steps as it was asked for', () => {
    for (const levels of [2, 4, 8, 16]) {
      const pixels = field(32, 32, 128)
      dither(pixels, { ...base, levels })
      const sorted = [...values(pixels)].sort((one, other) => one - other)
      // At most one value per step, and the steps are even: a channel can hold whole bytes, so the
      // spacing between two of them is the ideal step rounded to one.
      expect(sorted.length, `${levels} levels used ${sorted.length} values`).toBeLessThanOrEqual(levels)
      const step = 255 / (levels - 1)
      for (let index = 1; index < sorted.length; index += 1) {
        const spacing = sorted[index] - sorted[index - 1]
        expect(Math.abs(spacing - step), `spacing at ${sorted[index]}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('is a no-op at the levels a channel already has', () => {
    const pixels = ramp(32, 8)
    const before = pixels.data.slice()
    dither(pixels, { ...base, levels: 256 })
    expect(pixels.data).toEqual(before)
  })

  it('decides a monochromatic pixel once and writes it to three channels', () => {
    const pixels = ramp(32, 16)
    dither(pixels, { ...base, monochromatic: true })
    for (let at = 0; at < pixels.data.length; at += 4) {
      expect(pixels.data[at + 1], `pixel ${at / 4}`).toBe(pixels.data[at])
      expect(pixels.data[at + 2], `pixel ${at / 4}`).toBe(pixels.data[at])
    }
  })

  it('never touches alpha, and never dithers transparency into colour', () => {
    const pixels = field(16, 16, 128, 128)
    for (let at = 3; at < pixels.data.length; at += 4) pixels.data[at] = 40
    const before = new Uint8ClampedArray(pixels.data)
    dither(pixels, base)
    for (let at = 3; at < pixels.data.length; at += 4) expect(pixels.data[at]).toBe(40)

    const holes = field(16, 16, 128)
    for (let at = 0; at < holes.data.length; at += 4) {
      if ((at / 4) % 3 === 0) holes.data[at + 3] = 0
    }
    dither(holes, base)
    for (let at = 0; at < holes.data.length; at += 4) {
      if (holes.data[at + 3] !== 0) continue
      // Nothing was written where there was nothing, not even a black pixel.
      expect([holes.data[at], holes.data[at + 1], holes.data[at + 2]]).toEqual([128, 128, 128])
    }
    expect(before.length).toBe(pixels.data.length)
  })
})
