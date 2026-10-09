import { describe, expect, it } from 'vitest'

import { tonalContrast, type TonalSettings } from '../tonalContrast'
import type { Rgba } from '../types'

/** A one-row buffer from a list of grey values, opaque. */
function greys(values: number[]): Rgba {
  const data = new Uint8ClampedArray(values.length * 4)
  values.forEach((value, index) => {
    data[index * 4] = value
    data[index * 4 + 1] = value
    data[index * 4 + 2] = value
    data[index * 4 + 3] = 255
  })
  return { data, width: values.length, height: 1 }
}

/** A uniform grey buffer. */
function flat(width: number, height: number, value: number): Rgba {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data[pixel * 4] = value
    data[pixel * 4 + 1] = value
    data[pixel * 4 + 2] = value
    data[pixel * 4 + 3] = 255
  }
  return { data, width, height }
}

function red(source: Rgba, x: number, y: number): number {
  return source.data[(y * source.width + x) * 4]
}

const settings: TonalSettings = { amount: 50, shadows: 40, midtones: 60, highlights: 30 }

describe('tonal contrast on a flat field', () => {
  it('changes nothing, because there is no local contrast in it', () => {
    const image = flat(16, 16, 128)
    const blurred = flat(16, 16, 128)
    const before = image.data.slice()
    tonalContrast(image, blurred, settings)
    expect(image.data).toEqual(before)
  })
})

describe('tonal contrast across a step edge', () => {
  it('pushes the dark side down and the bright side up', () => {
    const image = flat(16, 16, 64)
    for (let y = 0; y < 16; y += 1) {
      for (let x = 8; x < 16; x += 1) {
        const at = (y * 16 + x) * 4
        image.data[at] = 192
        image.data[at + 1] = 192
        image.data[at + 2] = 192
      }
    }
    // A blurred copy of the edge, simplified to the mean of the two sides.
    const blurred = flat(16, 16, 128)
    tonalContrast(image, blurred, settings)
    expect(red(image, 3, 8)).toBeLessThan(60)
    expect(red(image, 12, 8)).toBeGreaterThan(200)
  })
})

describe('the tone bands', () => {
  // Three pixels, one in each band, each a little brighter than its blurred copy so there is
  // detail to push. Base luminances 26, 128 and 210 land at the centres of shadows, midtones and
  // highlights respectively.
  const base = greys([26, 128, 210])
  const source = greys([56, 158, 240])

  function changes(withBand: Partial<TonalSettings>): number[] {
    const work: Rgba = { data: source.data.slice(), width: source.width, height: source.height }
    tonalContrast(work, base, { ...settings, shadows: 0, midtones: 0, highlights: 0, ...withBand })
    return [0, 1, 2].map((index) => work.data[index * 4] - source.data[index * 4])
  }

  it('moves the shadows most when only the shadows are set', () => {
    const [dark, mid, bright] = changes({ shadows: 100 })
    expect(dark).toBeGreaterThan(mid)
    expect(dark).toBeGreaterThan(bright)
    expect(dark).toBeGreaterThan(10)
  })

  it('moves the midtones most when only the midtones are set', () => {
    const [dark, mid, bright] = changes({ midtones: 100 })
    expect(mid).toBeGreaterThan(dark)
    expect(mid).toBeGreaterThan(bright)
    expect(mid).toBeGreaterThan(10)
  })

  it('moves the highlights most when only the highlights are set', () => {
    const [dark, mid, bright] = changes({ highlights: 100 })
    expect(bright).toBeGreaterThan(dark)
    expect(bright).toBeGreaterThan(mid)
    expect(bright).toBeGreaterThan(2)
  })
})

describe('an amount of zero', () => {
  it('is the identity', () => {
    const image = greys([56, 158, 240])
    const before = image.data.slice()
    tonalContrast(image, greys([26, 128, 210]), { ...settings, amount: 0 })
    expect(image.data).toEqual(before)
  })
})
