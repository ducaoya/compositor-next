import { describe, expect, it } from 'vitest'

import {
  blurMask,
  boxRadiusForSigma,
  createMask,
  dilateMask,
  erodeMask,
  invertMask,
  magicWandMask,
  maskBounds,
  maskCoverage,
  maskFromShape,
} from '../selectionMask'

function coverageAt(mask: ReturnType<typeof createMask>, x: number, y: number): number {
  return mask.data[y * mask.width + x]
}

describe('rasterising a shape', () => {
  it('fills a rectangle and leaves the rest alone', () => {
    const mask = maskFromShape(
      { kind: 'rectangle', bounds: { x: 10, y: 10, width: 20, height: 10 } },
      64,
      64,
    )
    expect(coverageAt(mask, 20, 15)).toBe(255)
    expect(coverageAt(mask, 5, 15)).toBe(0)
    expect(coverageAt(mask, 20, 25)).toBe(0)
    expect(maskBounds(mask)).toEqual({ x: 10, y: 10, width: 20, height: 10 })
  })

  it('leaves the corners of an ellipse out', () => {
    const mask = maskFromShape({ kind: 'ellipse', bounds: { x: 0, y: 0, width: 40, height: 40 } }, 40, 40)
    expect(coverageAt(mask, 20, 20)).toBeGreaterThan(200)
    expect(coverageAt(mask, 1, 1)).toBe(0)
    expect(coverageAt(mask, 20, 1)).toBeGreaterThan(0)
  })

  /** The notch of an L is the thing a bounding-box test would get wrong. */
  it('leaves the notch of a polygon out', () => {
    const mask = maskFromShape(
      {
        kind: 'polygon',
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        points: [
          [0, 0],
          [100, 0],
          [100, 40],
          [40, 40],
          [40, 100],
          [0, 100],
        ],
      },
      100,
      100,
    )
    expect(coverageAt(mask, 20, 20)).toBe(255)
    expect(coverageAt(mask, 80, 20)).toBe(255)
    expect(coverageAt(mask, 80, 80)).toBe(0)
  })

  it('gives the end of a row partial coverage, which is what antialiases the edge', () => {
    const mask = maskFromShape({ kind: 'rectangle', bounds: { x: 10.5, y: 4, width: 5, height: 2 } }, 32, 16)
    expect(coverageAt(mask, 10, 5)).toBe(128)
    expect(coverageAt(mask, 15, 5)).toBe(128)
    expect(coverageAt(mask, 12, 5)).toBe(255)
  })
})

describe('inverting', () => {
  it('turns coverage inside out', () => {
    const mask = maskFromShape({ kind: 'rectangle', bounds: { x: 0, y: 0, width: 4, height: 4 } }, 8, 8)
    const flipped = invertMask(mask)
    expect(coverageAt(flipped, 1, 1)).toBe(0)
    expect(coverageAt(flipped, 6, 6)).toBe(255)
    expect(maskCoverage(flipped)).toBeCloseTo(1 - maskCoverage(mask), 6)
  })
})

describe('feathering', () => {
  it('turns the box radius into a Gaussian of the sigma asked for', () => {
    expect(boxRadiusForSigma(0)).toBe(0)
    expect(boxRadiusForSigma(1)).toBe(1)
    // A bigger feather never gives a smaller radius.
    expect(boxRadiusForSigma(10)).toBeGreaterThan(boxRadiusForSigma(4))
  })

  it('softens the edge without moving the middle', () => {
    const mask = maskFromShape({ kind: 'rectangle', bounds: { x: 16, y: 16, width: 32, height: 32 } }, 64, 64)
    const blurred = blurMask(mask, 3)
    expect(coverageAt(blurred, 32, 32)).toBeGreaterThan(240)
    // The hard edge becomes a ramp.
    expect(coverageAt(blurred, 16, 32)).toBeGreaterThan(0)
    expect(coverageAt(blurred, 16, 32)).toBeLessThan(255)
    expect(coverageAt(blurred, 13, 32)).toBeLessThan(64)
  })

  it('leaves a mask alone when the radius rounds to nothing', () => {
    const mask = maskFromShape({ kind: 'rectangle', bounds: { x: 0, y: 0, width: 4, height: 4 } }, 8, 8)
    expect(Array.from(blurMask(mask, 0.1).data)).toEqual(Array.from(mask.data))
  })
})

describe('expanding and contracting', () => {
  it('grows the selection outwards', () => {
    const mask = maskFromShape({ kind: 'rectangle', bounds: { x: 20, y: 20, width: 10, height: 10 } }, 64, 64)
    const grown = dilateMask(mask, 3)
    expect(maskBounds(grown)).toEqual({ x: 17, y: 17, width: 16, height: 16 })
    expect(coverageAt(grown, 20, 20)).toBe(255)
  })

  it('shrinks it inwards', () => {
    const mask = maskFromShape({ kind: 'rectangle', bounds: { x: 20, y: 20, width: 10, height: 10 } }, 64, 64)
    const shrunk = erodeMask(mask, 3)
    expect(maskBounds(shrunk)).toEqual({ x: 23, y: 23, width: 4, height: 4 })
    expect(coverageAt(shrunk, 20, 20)).toBe(0)
  })

  it('erases a selection thinner than the amount', () => {
    const mask = maskFromShape({ kind: 'rectangle', bounds: { x: 20, y: 20, width: 4, height: 4 } }, 32, 32)
    expect(maskBounds(erodeMask(mask, 5))).toBeNull()
  })

  it('does nothing at zero', () => {
    const mask = maskFromShape({ kind: 'rectangle', bounds: { x: 4, y: 4, width: 4, height: 4 } }, 16, 16)
    expect(Array.from(dilateMask(mask, 0).data)).toEqual(Array.from(mask.data))
    expect(Array.from(erodeMask(mask, 0).data)).toEqual(Array.from(mask.data))
  })
})

describe('the magic wand', () => {
  /** A 4 × 4 image: the left half red, the right half blue. */
  function halves(): { pixels: Uint8ClampedArray; width: number; height: number } {
    const width = 4
    const height = 4
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4
        const red = x < 2
        pixels[index] = red ? 255 : 0
        pixels[index + 1] = 0
        pixels[index + 2] = red ? 0 : 255
        pixels[index + 3] = 255
      }
    }
    return { pixels, width, height }
  }

  it('takes the region joined to the pixel clicked', () => {
    const { pixels, width, height } = halves()
    const mask = magicWandMask(pixels, width, height, 0, 0, 0)
    expect(coverageAt(mask, 0, 0)).toBe(255)
    expect(coverageAt(mask, 1, 3)).toBe(255)
    expect(coverageAt(mask, 2, 0)).toBe(0)
    expect(maskCoverage(mask)).toBeCloseTo(0.5, 2)
  })

  it('takes everything within the tolerance when it is not contiguous', () => {
    const { pixels, width, height } = halves()
    const mask = magicWandMask(pixels, width, height, 0, 0, 0, false)
    expect(coverageAt(mask, 0, 0)).toBe(255)
    expect(coverageAt(mask, 3, 3)).toBe(0)
  })

  it('takes the other half as well once the tolerance is wide enough', () => {
    const { pixels, width, height } = halves()
    const mask = magicWandMask(pixels, width, height, 0, 0, 255)
    expect(coverageAt(mask, 3, 3)).toBe(255)
  })

  it('crosses the boundary only where the pixels actually match', () => {
    // A checkerboard: contiguous should take one parity, not a half.
    const width = 4
    const height = 4
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4
        const on = (x + y) % 2 === 0
        pixels[index] = on ? 255 : 0
        pixels[index + 3] = 255
      }
    }
    const mask = magicWandMask(pixels, width, height, 0, 0, 0)
    // Only the four corners of this parity touch diagonally, and a flood fill does not cross a
    // diagonal, so from the top-left corner only that corner is taken.
    expect(coverageAt(mask, 0, 0)).toBe(255)
    expect(coverageAt(mask, 1, 0)).toBe(0)
    expect(coverageAt(mask, 2, 2)).toBe(0)
  })

  it('is empty for a click outside the image', () => {
    const { pixels, width, height } = halves()
    expect(maskBounds(magicWandMask(pixels, width, height, 99, 99, 10))).toBeNull()
  })
})
