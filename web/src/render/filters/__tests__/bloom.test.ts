import { describe, expect, it } from 'vitest'

import { glow } from '../bloom'
import type { Rgba } from '../types'

function black(width: number, height: number): Rgba {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel += 1) data[pixel * 4 + 3] = 255
  return { data, width, height }
}

function channel(source: Rgba, x: number, y: number, offset: number): number {
  return source.data[(y * source.width + x) * 4 + offset]
}

/** The sum of the red channel, a stand-in for the image's energy. */
function energy(source: Rgba): number {
  let total = 0
  for (let pixel = 0; pixel < source.width * source.height; pixel += 1) total += source.data[pixel * 4]
  return total
}

describe('a glow over a black image', () => {
  it('gains nothing, because there are no highlights to spread', () => {
    const image = black(32, 32)
    const result = glow(image, 3, 1)
    for (let index = 0; index < result.data.length; index += 1) {
      // The colour channels stay black; the alpha the image already had is carried through.
      if (index % 4 === 3) expect(result.data[index]).toBe(image.data[index])
      else expect(result.data[index]).toBe(0)
    }
  })
})

describe('a glow over a bright spot', () => {
  it('spreads into the surrounding dark and gains energy', () => {
    const image = black(32, 32)
    for (let y = 14; y <= 18; y += 1) {
      for (let x = 14; x <= 18; x += 1) {
        const at = (y * 32 + x) * 4
        image.data[at] = 255
        image.data[at + 1] = 255
        image.data[at + 2] = 255
      }
    }
    const before = energy(image)
    const result = glow(image, 3, 1)
    expect(energy(result)).toBeGreaterThan(before)
    // Three pixels beyond the block the image was black; the glow has reached it.
    expect(channel(image, 21, 16, 0)).toBe(0)
    expect(channel(result, 21, 16, 0)).toBeGreaterThan(0)
  })
})

describe('an amount of zero', () => {
  it('is an exact copy', () => {
    const image = black(16, 16)
    image.data[0] = 120
    image.data[1] = 60
    const result = glow(image, 3, 0)
    expect(result.data).toEqual(image.data)
    expect(result.data).not.toBe(image.data)
  })
})

describe('the direction of the change', () => {
  it('never darkens a channel', () => {
    const image = black(32, 32)
    for (let pixel = 0; pixel < 32 * 32; pixel += 1) {
      const value = (pixel * 37) % 256
      image.data[pixel * 4] = value
      image.data[pixel * 4 + 1] = (value + 80) % 256
      image.data[pixel * 4 + 2] = (value + 160) % 256
    }
    const result = glow(image, 4, 0.8)
    for (let index = 0; index < image.data.length; index += 1) {
      expect(result.data[index]).toBeGreaterThanOrEqual(image.data[index])
    }
  })
})
