import { describe, expect, it } from 'vitest'

import { addNoise, type NoiseSettings } from '../noise'
import type { Rgba } from '../types'

function grey(width: number, height: number, value: number): Rgba {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data[pixel * 4] = value
    data[pixel * 4 + 1] = value
    data[pixel * 4 + 2] = value
    data[pixel * 4 + 3] = 255
  }
  return { data, width, height }
}

function clone(source: Rgba): Rgba {
  return { data: source.data.slice(), width: source.width, height: source.height }
}

const base: NoiseSettings = { amount: 30, gaussian: false, monochromatic: false, seed: 7 }

describe('noise and the seed', () => {
  it('gives byte-identical output for the same seed, uniform and gaussian alike', () => {
    for (const gaussian of [false, true]) {
      const first = grey(32, 32, 128)
      const second = grey(32, 32, 128)
      addNoise(first, { ...base, gaussian })
      addNoise(second, { ...base, gaussian })
      expect(first.data).toEqual(second.data)
    }
  })

  it('gives different grain for a different seed', () => {
    const first = grey(32, 32, 128)
    const second = grey(32, 32, 128)
    addNoise(first, { ...base, seed: 1 })
    addNoise(second, { ...base, seed: 2 })
    expect(first.data).not.toEqual(second.data)
  })
})

describe('noise and alpha', () => {
  it('leaves every alpha byte where it was', () => {
    const image = grey(16, 16, 128)
    addNoise(image, base)
    for (let pixel = 0; pixel < 16 * 16; pixel += 1) expect(image.data[pixel * 4 + 3]).toBe(255)
  })

  it('leaves a fully transparent pixel alone, colour included', () => {
    const image = grey(16, 16, 128)
    // A canvas can hold colour under a zero alpha; there is nothing there to add noise to.
    const at = (5 * 16 + 5) * 4
    image.data[at] = 200
    image.data[at + 1] = 200
    image.data[at + 2] = 200
    image.data[at + 3] = 0
    addNoise(image, { ...base, amount: 80 })
    expect(image.data[at]).toBe(200)
    expect(image.data[at + 1]).toBe(200)
    expect(image.data[at + 2]).toBe(200)
    expect(image.data[at + 3]).toBe(0)
  })
})

describe('monochromatic noise', () => {
  it('moves all three channels of a grey by the same amount', () => {
    const image = grey(32, 32, 128)
    const before = clone(image)
    addNoise(image, { ...base, amount: 20, monochromatic: true })
    for (let pixel = 0; pixel < 32 * 32; pixel += 1) {
      const at = pixel * 4
      const red = image.data[at] - before.data[at]
      const green = image.data[at + 1] - before.data[at + 1]
      const blue = image.data[at + 2] - before.data[at + 2]
      expect(red).toBe(green)
      expect(green).toBe(blue)
    }
  })

  it('is the only mode that does, since coloured noise draws each channel separately', () => {
    const image = grey(32, 32, 128)
    const before = clone(image)
    addNoise(image, { ...base, amount: 40, monochromatic: false })
    let differing = 0
    for (let pixel = 0; pixel < 32 * 32; pixel += 1) {
      const at = pixel * 4
      const red = image.data[at] - before.data[at]
      const green = image.data[at + 1] - before.data[at + 1]
      if (red !== green) differing += 1
    }
    expect(differing).toBeGreaterThan(0)
  })
})

describe('an amount of zero', () => {
  it('is the identity', () => {
    const image = grey(16, 16, 128)
    const before = image.data.slice()
    addNoise(image, { ...base, amount: 0 })
    expect(image.data).toEqual(before)
  })
})

describe('the distribution', () => {
  it('leaves the mean roughly where it was, so it is noise and not a shift', () => {
    const image = grey(64, 64, 128)
    let before = 0
    for (let pixel = 0; pixel < 64 * 64; pixel += 1) before += image.data[pixel * 4]
    before /= 64 * 64
    addNoise(image, { ...base, amount: 30 })
    let after = 0
    for (let pixel = 0; pixel < 64 * 64; pixel += 1) after += image.data[pixel * 4]
    after /= 64 * 64
    // With 4096 samples the standard error of the mean is well under one byte, so two is generous.
    expect(Math.abs(after - before)).toBeLessThan(2)
  })
})
