import { describe, expect, it } from 'vitest'

import { lensDistort } from '../lens'
import type { Rgba } from '../types'

/** 32×32 of grey 100, opaque, with a bright marker at (24, 24). */
function marked(): Rgba {
  const image = { data: new Uint8ClampedArray(32 * 32 * 4), width: 32, height: 32 }
  for (let pixel = 0; pixel < 32 * 32; pixel += 1) {
    image.data[pixel * 4] = 100
    image.data[pixel * 4 + 1] = 100
    image.data[pixel * 4 + 2] = 100
    image.data[pixel * 4 + 3] = 255
  }
  image.data[(24 * 32 + 24) * 4] = 255
  image.data[(24 * 32 + 24) * 4 + 1] = 255
  image.data[(24 * 32 + 24) * 4 + 2] = 255
  return image
}

function empty(width: number, height: number): Rgba {
  return { data: new Uint8ClampedArray(width * height * 4), width, height }
}

function channel(source: Rgba, x: number, y: number, offset: number): number {
  return source.data[(y * source.width + x) * 4 + offset]
}

describe('lens distortion at zero strength', () => {
  it('copies the source exactly', () => {
    const source = marked()
    const destination = empty(32, 32)
    lensDistort(source, destination, 0)
    expect(destination.data).toEqual(source.data)
  })
})

describe('lens distortion with a positive k', () => {
  it('keeps the centre and pulls the pattern outward, magnifying it', () => {
    const source = marked()
    const destination = empty(32, 32)
    lensDistort(source, destination, 0.5)
    // The centre samples itself, so it is unchanged within a byte.
    expect(Math.abs(channel(destination, 16, 16, 0) - 100)).toBeLessThanOrEqual(1)
    // The marker at (24, 24) is sampled by pixels farther out than it, so it spreads outward:
    // (26, 26) was plain grey and now carries the marker.
    expect(channel(source, 26, 26, 0)).toBe(100)
    expect(channel(destination, 26, 26, 0)).toBeGreaterThan(150)
  })
})

describe('lens distortion with a negative k', () => {
  it('leaves the corners transparent, because the sample falls outside the source', () => {
    const source = marked()
    const destination = empty(32, 32)
    lensDistort(source, destination, -1)
    expect(channel(destination, 0, 0, 3)).toBe(0)
    expect(channel(destination, 31, 31, 3)).toBe(0)
    // The centre is still inside the image.
    expect(Math.abs(channel(destination, 16, 16, 0) - 100)).toBeLessThanOrEqual(1)
  })
})

describe('lens distortion at extreme strengths', () => {
  it('stays inside the buffer and leaves the centre sane', () => {
    const source = marked()
    for (const k of [5, -5]) {
      const destination = empty(32, 32)
      expect(() => lensDistort(source, destination, k)).not.toThrow()
      expect(destination.data.length).toBe(source.data.length)
      expect(Math.abs(channel(destination, 16, 16, 0) - 100)).toBeLessThanOrEqual(1)
      expect(destination.data.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)).toBe(true)
    }
  })
})
