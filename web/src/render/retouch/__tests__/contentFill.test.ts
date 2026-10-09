import { describe, expect, it } from 'vitest'

import { contentFill } from '../contentFill'
import type { Rgba } from '../types'

function fill(width: number, height: number, colour: [number, number, number, number]): Rgba {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    for (let channel = 0; channel < 4; channel += 1) data[pixel * 4 + channel] = colour[channel]
  }
  return { data, width, height }
}

function rectangle(width: number, height: number, x0: number, y0: number, w: number, h: number): Uint8ClampedArray {
  const mask = new Uint8ClampedArray(width * height)
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) mask[y * width + x] = 255
  }
  return mask
}

function redAt(source: Rgba, x: number, y: number): number {
  return source.data[(y * source.width + x) * 4]
}

describe('content-aware fill over a solid colour', () => {
  it('fills the hole with that colour', () => {
    const target = fill(32, 32, [80, 120, 160, 255])
    expect(contentFill(target, rectangle(32, 32, 13, 13, 6, 6))).toBe(true)
    for (let y = 13; y < 19; y += 1) {
      for (let x = 13; x < 19; x += 1) {
        expect(redAt(target, x, y)).toBe(80)
        expect(target.data[(y * 32 + x) * 4 + 1]).toBe(120)
        expect(target.data[(y * 32 + x) * 4 + 2]).toBe(160)
      }
    }
  })
})

describe('content-aware fill across a hard edge', () => {
  it('continues the edge through the hole', () => {
    const target = fill(32, 32, [0, 0, 0, 255])
    for (let y = 0; y < 32; y += 1) {
      for (let x = 16; x < 32; x += 1) {
        const at = (y * 32 + x) * 4
        target.data[at] = 255
        target.data[at + 1] = 255
        target.data[at + 2] = 255
      }
    }
    // The hole straddles the boundary at x = 16.
    expect(contentFill(target, rectangle(32, 32, 14, 14, 4, 4))).toBe(true)
    let left = 0
    let right = 0
    for (let y = 14; y < 18; y += 1) {
      left += redAt(target, 14, y) + redAt(target, 15, y)
      right += redAt(target, 16, y) + redAt(target, 17, y)
    }
    expect(left / 8).toBeLessThan(60)
    expect(right / 8).toBeGreaterThan(195)
  })
})

describe('content-aware fill with nothing to fill', () => {
  it('returns false and changes nothing when the mask selects nothing', () => {
    const target = fill(16, 16, [10, 20, 30, 255])
    const before = [...target.data]
    expect(contentFill(target, new Uint8ClampedArray(16 * 16))).toBe(false)
    expect([...target.data]).toEqual(before)
  })

  it('returns false and changes nothing when the mask selects everything', () => {
    const target = fill(16, 16, [10, 20, 30, 255])
    const before = [...target.data]
    const everything = new Uint8ClampedArray(16 * 16).fill(255)
    expect(contentFill(target, everything)).toBe(false)
    expect([...target.data]).toEqual(before)
  })
})
