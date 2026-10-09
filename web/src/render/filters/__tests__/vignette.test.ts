import { describe, expect, it } from 'vitest'

import { vignette, type VignetteSettings } from '../vignette'
import type { Rgba } from '../types'

/** A uniform buffer of one colour, opaque. */
function fill(width: number, height: number, value: number): Rgba {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data[pixel * 4] = value
    data[pixel * 4 + 1] = value
    data[pixel * 4 + 2] = value
    data[pixel * 4 + 3] = 255
  }
  return { data, width, height }
}

function channel(source: Rgba, x: number, y: number, offset: number): number {
  return source.data[(y * source.width + x) * 4 + offset]
}

/** The usual darkening vignette: black at the corners, no highlight protection. */
const darkening: VignetteSettings = {
  amount: -60,
  midpoint: 40,
  roundness: 100,
  feather: 50,
  highlights: 0,
  colour: [0, 0, 0],
}

describe('a darkening vignette', () => {
  it('darkens the corners and leaves the exact centre alone', () => {
    const image = fill(32, 32, 128)
    vignette(image, { x: 0, y: 0, width: 32, height: 32 }, darkening)
    // The centre is inside the midpoint, so the mask is zero there and the byte is untouched.
    expect(channel(image, 16, 16, 0)).toBe(128)
    expect(channel(image, 0, 0, 0)).toBeLessThan(100)
    expect(channel(image, 31, 31, 0)).toBeLessThan(100)
    expect(channel(image, 0, 31, 0)).toBeLessThan(100)
    expect(channel(image, 31, 0, 0)).toBeLessThan(100)
  })

  it('leaves the alpha of an opaque pixel where it was', () => {
    const image = fill(32, 32, 128)
    vignette(image, { x: 0, y: 0, width: 32, height: 32 }, darkening)
    for (let pixel = 0; pixel < 32 * 32; pixel += 1) expect(image.data[pixel * 4 + 3]).toBe(255)
  })
})

describe('a lightening vignette', () => {
  it('lightens the corners whatever colour is set, because positive amounts go to white', () => {
    const image = fill(32, 32, 128)
    vignette(image, { x: 0, y: 0, width: 32, height: 32 }, { ...darkening, amount: 60, colour: [0, 0, 0] })
    expect(channel(image, 16, 16, 0)).toBe(128)
    expect(channel(image, 0, 0, 0)).toBeGreaterThan(180)
    expect(channel(image, 0, 0, 1)).toBeGreaterThan(180)
  })
})

describe('an amount of zero', () => {
  it('changes nothing at all', () => {
    const image = fill(32, 32, 128)
    const before = image.data.slice()
    vignette(image, { x: 0, y: 0, width: 32, height: 32 }, { ...darkening, amount: 0 })
    expect(image.data).toEqual(before)
  })
})

describe('an off-centre frame', () => {
  it('centres the falloff on the frame, so the frame keeps its middle and the image loses it', () => {
    const image = fill(64, 64, 128)
    // The bottom-right quarter, top-down.
    vignette(image, { x: 32, y: 32, width: 32, height: 32 }, { ...darkening, amount: -80 })
    // The frame's own centre is the quiet point now.
    expect(channel(image, 48, 48, 0)).toBe(128)
    // The image's centre is the frame's corner, so it is darkened: the falloff followed the frame.
    expect(channel(image, 32, 32, 0)).toBeLessThan(100)
    expect(channel(image, 0, 0, 0)).toBeLessThan(100)
  })
})

describe('a coloured vignette', () => {
  it('pulls the corners towards the chosen colour rather than merely darkening them', () => {
    const grey = fill(32, 32, 128)
    vignette(grey, { x: 0, y: 0, width: 32, height: 32 }, { ...darkening, amount: -80, colour: [200, 40, 40] })
    // The corner took on the colour: red is now well clear of the other two, which a plain
    // darkening could never do to a grey.
    expect(channel(grey, 0, 0, 0)).toBeGreaterThan(channel(grey, 0, 0, 1) + 50)
    expect(channel(grey, 0, 0, 0)).toBeGreaterThan(channel(grey, 0, 0, 2) + 50)
    expect(channel(grey, 0, 0, 0)).toBeGreaterThan(128)

    // The same run with black instead keeps the corner neutral: the colour is what tints it.
    const neutral = fill(32, 32, 128)
    vignette(neutral, { x: 0, y: 0, width: 32, height: 32 }, { ...darkening, amount: -80 })
    expect(channel(neutral, 0, 0, 0)).toBe(channel(neutral, 0, 0, 1))
    expect(channel(neutral, 0, 0, 1)).toBe(channel(neutral, 0, 0, 2))
  })
})

describe('highlight protection', () => {
  it('protects a bright corner more than a dark one at the same distance', () => {
    const dark = fill(32, 32, 64)
    const bright = fill(32, 32, 240)
    const settings: VignetteSettings = { ...darkening, amount: -80, highlights: 100 }
    vignette(dark, { x: 0, y: 0, width: 32, height: 32 }, settings)
    vignette(bright, { x: 0, y: 0, width: 32, height: 32 }, settings)
    const darkChange = 64 - channel(dark, 0, 0, 0)
    const brightChange = 240 - channel(bright, 0, 0, 0)
    expect(brightChange).toBeLessThan(darkChange)
    expect(darkChange).toBeGreaterThan(30)
  })
})

describe('a frame that is not the whole image', () => {
  it('paints the colour into clear pixels, which a whole-image frame would skip', () => {
    const clear = fill(32, 32, 0)
    for (let pixel = 0; pixel < 32 * 32; pixel += 1) clear.data[pixel * 4 + 3] = 0
    const settings: VignetteSettings = { ...darkening, amount: -60, midpoint: 0, colour: [0, 0, 200] }
    // The top-left quarter is the frame, so clear pixels are filled rather than skipped.
    vignette(clear, { x: 0, y: 0, width: 16, height: 16 }, settings)
    expect(channel(clear, 0, 0, 3)).toBeGreaterThan(0)
    expect(channel(clear, 0, 0, 2)).toBeGreaterThan(150)

    // The same buffer under a whole-image frame stays clear: the canvas is the image.
    const untouched = fill(32, 32, 0)
    for (let pixel = 0; pixel < 32 * 32; pixel += 1) untouched.data[pixel * 4 + 3] = 0
    vignette(untouched, { x: 0, y: 0, width: 32, height: 32 }, settings)
    expect(untouched.data.every((value) => value === 0)).toBe(true)
  })
})
