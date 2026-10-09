import { describe, expect, it } from 'vitest'

import { coverageBounds, spotHeal } from '../heal'
import type { Rgba } from '../types'

function fill(width: number, height: number, colour: [number, number, number, number]): Rgba {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    for (let channel = 0; channel < 4; channel += 1) data[pixel * 4 + channel] = colour[channel]
  }
  return { data, width, height }
}

/** A coverage mask that is zero everywhere except a solid rectangle. */
function rectangle(width: number, height: number, x0: number, y0: number, w: number, h: number): Uint8ClampedArray {
  const coverage = new Uint8ClampedArray(width * height)
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) coverage[y * width + x] = 255
  }
  return coverage
}

function redAt(source: Rgba, x: number, y: number): number {
  return source.data[(y * source.width + x) * 4]
}

describe('the bounds of a coverage mask', () => {
  it('are the half-open box around the non-zero bytes', () => {
    const coverage = rectangle(32, 32, 5, 7, 4, 6)
    expect(coverageBounds(coverage, 32, 32)).toEqual({ x: 5, y: 7, width: 4, height: 6 })
  })

  it('are null when nothing is covered', () => {
    expect(coverageBounds(new Uint8ClampedArray(32 * 32), 32, 32)).toBeNull()
  })
})

describe('spot healing a solid colour', () => {
  const colour: [number, number, number, number] = [100, 150, 200, 255]

  for (const mode of [0, 1, 2] as const) {
    it(`returns the surrounding colour in mode ${mode}`, () => {
      const target = fill(32, 32, colour)
      const coverage = rectangle(32, 32, 13, 13, 6, 6)
      expect(spotHeal(target, coverage, 1, mode, 1)).toBe(true)
      for (let y = 13; y < 19; y += 1) {
        for (let x = 13; x < 19; x += 1) {
          expect(redAt(target, x, y)).toBeGreaterThan(98)
          expect(redAt(target, x, y)).toBeLessThan(102)
          expect(target.data[(y * 32 + x) * 4 + 1]).toBeGreaterThan(148)
          expect(target.data[(y * 32 + x) * 4 + 2]).toBeGreaterThan(198)
        }
      }
    })
  }
})

describe('spot healing with nothing to do', () => {
  it('returns false and changes nothing when the coverage is empty', () => {
    const target = fill(16, 16, [10, 20, 30, 255])
    const before = [...target.data]
    expect(spotHeal(target, new Uint8ClampedArray(16 * 16), 1, 0, 1)).toBe(false)
    expect([...target.data]).toEqual(before)
  })
})

describe('spot healing across a two-tone edge', () => {
  it('fills between the tones rather than picking one of them', () => {
    // Create Texture mode: there is no patch to copy, so the whole fill is the membrane solve, and
    // that is the part this test is about. The ring averages black and white, so a solve that
    // worked lands the hole in the middle; one that had collapsed to either side would not.
    const target = fill(32, 32, [20, 20, 20, 255])
    for (let y = 0; y < 32; y += 1) {
      for (let x = 16; x < 32; x += 1) {
        const at = (y * 32 + x) * 4
        target.data[at] = 235
        target.data[at + 1] = 235
        target.data[at + 2] = 235
      }
    }
    const coverage = rectangle(32, 32, 14, 14, 4, 4)
    expect(spotHeal(target, coverage, 1, 1, 1)).toBe(true)
    let sum = 0
    let count = 0
    for (let y = 14; y < 18; y += 1) {
      for (let x = 14; x < 18; x += 1) {
        sum += redAt(target, x, y)
        count += 1
      }
    }
    const mean = sum / count
    expect(mean).toBeGreaterThan(60)
    expect(mean).toBeLessThan(200)
  })
})

describe('the grain a seed drives', () => {
  it('is the same for the same seed', () => {
    const textured = (): Rgba => {
      const target = fill(32, 32, [0, 0, 0, 255])
      for (let y = 0; y < 32; y += 1) {
        for (let x = 0; x < 32; x += 1) {
          const value = (x * 37 + y * 91) % 256
          for (let channel = 0; channel < 3; channel += 1) target.data[(y * 32 + x) * 4 + channel] = value
        }
      }
      return target
    }
    const first = textured()
    const second = textured()
    expect(spotHeal(first, rectangle(32, 32, 13, 13, 5, 5), 1, 1, 12345)).toBe(true)
    expect(spotHeal(second, rectangle(32, 32, 13, 13, 5, 5), 1, 1, 12345)).toBe(true)
    expect([...first.data]).toEqual([...second.data])
  })

  it('may differ for a different seed', () => {
    const textured = (): Rgba => {
      const target = fill(32, 32, [0, 0, 0, 255])
      for (let y = 0; y < 32; y += 1) {
        for (let x = 0; x < 32; x += 1) {
          const value = (x * 37 + y * 91) % 256
          for (let channel = 0; channel < 3; channel += 1) target.data[(y * 32 + x) * 4 + channel] = value
        }
      }
      return target
    }
    const first = textured()
    const second = textured()
    spotHeal(first, rectangle(32, 32, 13, 13, 5, 5), 1, 1, 12345)
    spotHeal(second, rectangle(32, 32, 13, 13, 5, 5), 1, 1, 999)
    expect([...first.data]).not.toEqual([...second.data])
  })
})
