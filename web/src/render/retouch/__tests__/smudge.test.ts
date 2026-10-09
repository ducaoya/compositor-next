import { describe, expect, it } from 'vitest'

import { smudgeDab, smudgePickUp } from '../smudge'
import type { Rgba } from '../types'

/** A 16-pixel-wide buffer split down the middle: black on the left, white on the right. */
function split(): Rgba {
  const data = new Uint8ClampedArray(16 * 16 * 4)
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const value = x < 8 ? 0 : 255
      const at = (y * 16 + x) * 4
      data[at] = value
      data[at + 1] = value
      data[at + 2] = value
      data[at + 3] = 255
    }
  }
  return { data, width: 16, height: 16 }
}

describe('a smudge pick-up', () => {
  it('lifts the pixels under the brush, centred on the point', () => {
    const target = split()
    const carry = smudgePickUp(target, [10, 8], 3)
    expect(carry.side).toBe(7)
    // The centre of a 7 × 7 patch is entry 24 of 49; on the white side here, so 255.
    expect(carry.data[24 * 4]).toBe(255)
  })
})

describe('a smudge dab', () => {
  it('drags the colour across a boundary', () => {
    const target = split()
    const carry = smudgePickUp(target, [10, 8], 3)
    // Black under the destination, so anything that lands there came from the brush.
    expect(target.data[(8 * 16 + 5) * 4]).toBe(0)
    smudgeDab(target, carry, [5, 8], 3, 1, 1)
    expect(target.data[(8 * 16 + 5) * 4]).toBe(255)
  })

  it('carries what it left behind, not what it picked up', () => {
    const target = split()
    const carry = smudgePickUp(target, [10, 8], 3)
    expect(carry.data[24 * 4]).toBe(255)
    smudgeDab(target, carry, [5, 8], 3, 1, 0.5)
    // Half strength on black: the byte lands at 128, and the carry holds the un-rounded 127.5,
    // which is neither the 255 it picked up nor the 128 it wrote.
    expect(target.data[(8 * 16 + 5) * 4]).toBe(128)
    expect(carry.data[24 * 4]).toBe(127.5)
  })

  it('is a no-op when the whole dab is off the buffer', () => {
    const target = split()
    const carry = smudgePickUp(target, [10, 8], 3)
    const before = [...target.data]
    smudgeDab(target, carry, [-100, -100], 3, 1, 1)
    expect([...target.data]).toEqual(before)
  })
})
