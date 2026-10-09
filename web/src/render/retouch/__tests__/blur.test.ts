import { describe, expect, it } from 'vitest'

import { blurred, sharpened } from '../blur'
import type { Rgba } from '../types'

/** A buffer filled with one colour, so a test can then carve a shape out of it. */
function fill(width: number, height: number, colour: [number, number, number, number]): Rgba {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    for (let channel = 0; channel < 4; channel += 1) data[pixel * 4 + channel] = colour[channel]
  }
  return { data, width, height }
}

function channelSum(source: Rgba, channel: number): number {
  let sum = 0
  for (let index = channel; index < source.data.length; index += 4) sum += source.data[index]
  return sum
}

function redAt(source: Rgba, x: number, y: number): number {
  return source.data[(y * source.width + x) * 4]
}

describe('a Gaussian blur', () => {
  it('spreads a single white pixel and keeps about the same energy', () => {
    const source = fill(16, 16, [0, 0, 0, 255])
    source.data[(8 * 16 + 8) * 4] = 255
    const before = channelSum(source, 0)
    const result = blurred(source, 1)
    // Each output byte rounds, and the light is now spread over a couple of dozen pixels, so the
    // sum can drift a few units; anything much past that would mean light was lost at an edge.
    expect(Math.abs(channelSum(result, 0) - before)).toBeLessThan(8)
    // The centre has given some of its light away, and a neighbour has picked it up.
    expect(redAt(result, 8, 8)).toBeLessThan(255)
    expect(redAt(result, 7, 8) + redAt(result, 9, 8) + redAt(result, 8, 7) + redAt(result, 8, 9)).toBeGreaterThan(0)
  })

  it('leaves a step edge monotone', () => {
    const source = fill(16, 16, [255, 255, 255, 255])
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 8; x += 1) source.data[(y * 16 + x) * 4] = 0
    }
    const result = blurred(source, 2)
    const row = 8
    for (let x = 0; x < 15; x += 1) {
      expect(redAt(result, x + 1, row)).toBeGreaterThanOrEqual(redAt(result, x, row))
    }
  })

  it('does not darken the edge of the buffer', () => {
    // A canvas blurs a layer near its edge by repeating the edge pixel, so a flat white buffer has
    // to stay flat; a window that wrapped or faded to transparent would pull the border down.
    const source = fill(12, 12, [255, 255, 255, 255])
    const result = blurred(source, 3)
    for (let pixel = 0; pixel < result.width * result.height; pixel += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        expect(result.data[pixel * 4 + channel]).toBe(255)
      }
    }
  })

  it('is the identity for a sigma of zero', () => {
    const source = fill(8, 8, [10, 20, 30, 40])
    const result = blurred(source, 0)
    expect(result).not.toBe(source)
    expect([...result.data]).toEqual([...source.data])
  })
})

describe('an unsharp mask', () => {
  it('increases the contrast across an edge', () => {
    // A mid-grey step rather than black-and-white: the overshoot the mask adds has room to show
    // on both sides, where a 0…255 step would only clamp.
    const source = fill(16, 16, [200, 200, 200, 255])
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 8; x += 1) source.data[(y * 16 + x) * 4] = 100
    }
    const result = sharpened(source, 2, 1)
    const row = 8
    // The near-dark side drops below 100, the near-light side climbs above 200, so the step widens.
    const before = redAt(source, 9, row) - redAt(source, 6, row)
    const after = redAt(result, 9, row) - redAt(result, 6, row)
    expect(after).toBeGreaterThan(before)
  })

  it('is the identity for an amount of zero', () => {
    const source = fill(8, 8, [10, 20, 30, 40])
    const result = sharpened(source, 3, 0)
    expect([...result.data]).toEqual([...source.data])
  })
})
