import { describe, expect, it } from 'vitest'

import { dodgeBurn, sponge, toneWeight } from '../tone'

describe('the tone ranges', () => {
  it('are at full strength in the middle of their own range', () => {
    expect(toneWeight(0, 'shadows')).toBe(1)
    expect(toneWeight(0.5, 'midtones')).toBe(1)
    expect(toneWeight(1, 'highlights')).toBe(1)
  })

  it('are near nothing far outside it', () => {
    expect(toneWeight(0.9, 'shadows')).toBe(0)
    expect(toneWeight(0, 'midtones')).toBe(0)
    expect(toneWeight(0.1, 'highlights')).toBe(0)
  })

  it('tile the tone curve without a gap at the thresholds', () => {
    for (let tone = 0; tone <= 1.0001; tone += 0.01) {
      const total = toneWeight(tone, 'shadows') + toneWeight(tone, 'midtones') + toneWeight(tone, 'highlights')
      expect(Math.abs(total - 1)).toBeLessThan(1e-9)
    }
    // The two seams of the shader's curves sit at 0.333 and 0.667, and the weights meet there.
    expect(Math.abs(toneWeight(0.333, 'shadows') - toneWeight(0.333, 'midtones'))).toBeLessThan(1e-9)
  })
})

describe('a dodge or burn step', () => {
  it('is exactly the identity at zero weight or zero exposure', () => {
    expect(dodgeBurn(0.42, 0, 0.7, 'dodge')).toBe(0.42)
    expect(dodgeBurn(0.42, 0.7, 0, 'burn')).toBe(0.42)
  })

  it('moves a dodge towards white and never past it', () => {
    let value = 0.2
    for (let step = 0; step < 50; step += 1) {
      const next = dodgeBurn(value, 1, 0.2, 'dodge')
      expect(next).toBeGreaterThan(value)
      expect(next).toBeLessThanOrEqual(1)
      value = next
    }
  })

  it('moves a burn towards black and never past it', () => {
    let value = 0.8
    for (let step = 0; step < 50; step += 1) {
      const next = dodgeBurn(value, 1, 0.2, 'burn')
      expect(next).toBeLessThan(value)
      expect(next).toBeGreaterThanOrEqual(0)
      value = next
    }
  })
})

describe('a sponge dab', () => {
  it('leaves a grey alone, since there is no saturation to move', () => {
    expect(sponge([0.5, 0.5, 0.5], 1, 1, true)).toEqual([0.5, 0.5, 0.5])
    expect(sponge([0.5, 0.5, 0.5], 1, 1, false)).toEqual([0.5, 0.5, 0.5])
    expect(sponge([0, 0, 0], 1, 1, true)).toEqual([0, 0, 0])
    expect(sponge([1, 1, 1], 1, 1, false)).toEqual([1, 1, 1])
  })

  it('drains some colour when it desaturates', () => {
    const [red, green, blue] = sponge([0.9, 0.1, 0.1], 1, 1, false)
    const before = 0.9 - 0.1
    const after = Math.max(red, green, blue) - Math.min(red, green, blue)
    expect(after).toBeLessThan(before)
    // Hue is held: the green and blue channels move together, so the pixel stays red-ish.
    expect(green).toBeCloseTo(blue, 6)
  })
})
