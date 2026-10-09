import { describe, expect, it } from 'vitest'

import { covers, type Rgba } from '../types'

function buffer(width: number, height: number): Rgba {
  return { data: new Uint8ClampedArray(width * height * 4), width, height }
}

describe('a rectangle inside a buffer', () => {
  it('is covered when it lies within the pixels', () => {
    const target = buffer(16, 16)
    expect(covers(target, { x: 2, y: 3, width: 4, height: 5 })).toBe(true)
  })

  it('is covered when it is the whole buffer', () => {
    expect(covers(buffer(16, 16), { x: 0, y: 0, width: 16, height: 16 })).toBe(true)
  })

  it('is not covered when it pokes past an edge', () => {
    const target = buffer(16, 16)
    expect(covers(target, { x: 14, y: 0, width: 4, height: 4 })).toBe(false)
    expect(covers(target, { x: 0, y: 14, width: 4, height: 4 })).toBe(false)
  })

  it('is not covered when it starts outside', () => {
    const target = buffer(16, 16)
    expect(covers(target, { x: -1, y: 0, width: 4, height: 4 })).toBe(false)
    expect(covers(target, { x: 0, y: -1, width: 4, height: 4 })).toBe(false)
  })

  it('is not covered when its extent runs the wrong way', () => {
    // A half-open rectangle with a negative width is a bug in the caller, not an empty region.
    expect(covers(buffer(16, 16), { x: 4, y: 4, width: -2, height: 2 })).toBe(false)
  })
})
