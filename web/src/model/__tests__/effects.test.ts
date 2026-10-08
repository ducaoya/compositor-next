import { describe, expect, it } from 'vitest'

import {
  defaultEffect,
  dropShadowCoverage,
  EFFECT_ORDER,
  effectsMargin,
  hasEffects,
  innerGlowCoverage,
  innerShadowCoverage,
  outerGlowCoverage,
  overPaints,
  shadowOffset,
  shiftMask,
  strokeCoverage,
  underPaints,
  type LayerEffects,
  type ShadowEffect,
  type StrokeEffect,
} from '../effects'
import { createMask, maskBounds, maskFromShape, maskCoverage, type Mask } from '../selectionMask'

/** A filled square in the middle of a larger mask, the shape every case here is built on. */
function square(size = 20): Mask {
  return maskFromShape({ kind: 'rectangle', bounds: { x: 6, y: 6, width: 8, height: 8 } }, size, size)
}

function at(mask: Mask, x: number, y: number): number {
  return mask.data[y * mask.width + x]
}

const stroke = (over: Partial<StrokeEffect> = {}): StrokeEffect => ({
  size: 4,
  red: 0,
  green: 0,
  blue: 0,
  opacity: 1,
  inside: false,
  ...over,
})

const shadow = (over: Partial<ShadowEffect> = {}): ShadowEffect => ({
  angle: 90,
  distance: 6,
  blur: 0,
  red: 0,
  green: 0,
  blue: 0,
  opacity: 0.5,
  ...over,
})

describe('how far effects reach', () => {
  it('is nothing when there is nothing', () => {
    expect(effectsMargin(null)).toBe(0)
    expect(effectsMargin({})).toBe(0)
  })

  it('covers a shadow by its distance plus its blur', () => {
    expect(effectsMargin({ shadow: shadow({ distance: 10, blur: 4 }) })).toBeGreaterThanOrEqual(14)
  })

  it('ignores a stroke that is inside the shape, which cannot reach past it', () => {
    expect(effectsMargin({ stroke: stroke({ size: 40, inside: true }) })).toBe(0)
    expect(effectsMargin({ stroke: stroke({ size: 40, inside: false }) })).toBeGreaterThanOrEqual(40)
  })

  it('ignores an effect that is switched off', () => {
    expect(effectsMargin({ shadow: { ...shadow({ distance: 50 }), enabled: false } })).toBe(0)
  })

  it('knows the difference between an empty record and one with something', () => {
    expect(hasEffects({})).toBe(false)
    expect(hasEffects({ shadow: shadow() })).toBe(true)
    // Everything switched off means nothing to render, which is what this answers.
    expect(hasEffects({ shadow: { ...shadow(), enabled: false } })).toBe(false)
    expect(hasEffects(null)).toBe(false)
  })
})

describe('the shadow’s direction', () => {
  /** The angle is counterclockwise from the right, and the canvas has y pointing down. */
  it('drops the shadow straight down when the light is straight above', () => {
    const [dx, dy] = shadowOffset({ angle: 90, distance: 10 })
    expect(dx).toBeCloseTo(0, 6)
    expect(dy).toBeCloseTo(10, 6)
  })

  it('casts it away from the light, whichever side that is', () => {
    // Light from the right: the shadow goes left.
    const [rightX, rightY] = shadowOffset({ angle: 0, distance: 10 })
    expect(rightX).toBeCloseTo(-10, 6)
    expect(rightY).toBeCloseTo(0, 6)
    // Light from the left: it goes right.
    const [leftX, leftY] = shadowOffset({ angle: 180, distance: 10 })
    expect(leftX).toBeCloseTo(10, 6)
    expect(leftY).toBeCloseTo(0, 6)
  })
})

describe('shifting a mask', () => {
  it('moves it without wrapping round', () => {
    const mask = square()
    const moved = shiftMask(mask, 2, 0)
    expect(maskBounds(moved)).toEqual({ x: 8, y: 6, width: 8, height: 8 })
    // The column left behind is empty, not a copy of the far edge.
    expect(at(moved, 0, 8)).toBe(0)
  })
})

describe('a stroke', () => {
  it('outside, is a band that does not touch the shape’s own pixels', () => {
    const shape = square()
    const ring = strokeCoverage(shape, stroke({ size: 4, inside: false }))
    // The shape's middle is untouched.
    expect(at(ring, 10, 10)).toBe(0)
    // Two pixels out is inside the band.
    expect(at(ring, 4, 10)).toBeGreaterThan(0)
    // And it does not reach further than the stroke asked for.
    expect(at(ring, 0, 10)).toBe(0)
    expect(maskCoverage(ring)).toBeGreaterThan(0)
  })

  it('inside, eats into the shape instead of growing out of it', () => {
    const shape = square()
    const ring = strokeCoverage(shape, stroke({ size: 4, inside: true }))
    expect(at(ring, 10, 10)).toBe(0)
    expect(at(ring, 7, 10)).toBeGreaterThan(0)
    // Nothing outside the shape.
    expect(at(ring, 2, 10)).toBe(0)
    // And it never covers more than the shape did.
    expect(maskCoverage(ring)).toBeLessThan(maskCoverage(shape))
  })
})

describe('glows and shadows', () => {
  it('an outer glow spreads outwards and never inside', () => {
    const shape = square()
    const glow = outerGlowCoverage(shape, { size: 6, red: 0, green: 0, blue: 0, opacity: 1 })
    expect(at(glow, 10, 10)).toBeGreaterThan(0)
    expect(at(glow, 3, 10)).toBeGreaterThan(0)
    expect(maskBounds(glow)!.x).toBeLessThan(maskBounds(shape)!.x)
  })

  it('an inner glow stays inside the shape', () => {
    const shape = square()
    const glow = innerGlowCoverage(shape, { size: 4, red: 0, green: 0, blue: 0, opacity: 1 })
    expect(maskBounds(glow)).toEqual(maskBounds(shape))
    for (let y = 0; y < shape.height; y += 1) {
      for (let x = 0; x < shape.width; x += 1) {
        expect(at(glow, x, y)).toBeLessThanOrEqual(at(shape, x, y))
      }
    }
  })

  it('a drop shadow lands where the light puts it', () => {
    const shape = square()
    // Light from the right, so the shadow falls to the left.
    const left = dropShadowCoverage(shape, shadow({ angle: 0, distance: 6 }))
    expect(maskBounds(left)!.x).toBeLessThan(maskBounds(shape)!.x)
    // Light from above, so it falls downwards.
    const down = dropShadowCoverage(shape, shadow({ angle: 90, distance: 6 }))
    expect(maskBounds(down)!.y).toBeGreaterThan(maskBounds(shape)!.y)
  })

  it('an inner shadow stays inside, like an inner glow', () => {
    const shape = square()
    const inner = innerShadowCoverage(shape, shadow({ angle: 90, distance: 4, blur: 2 }))
    expect(maskBounds(inner)).toEqual(maskBounds(shape))
  })
})

describe('what is painted, and in what order', () => {
  it('puts the shadow and the glow under the layer', () => {
    const shape = square()
    const keys = underPaints(shape, { shadow: shadow(), outerGlow: { size: 4, red: 1, green: 1, blue: 1, opacity: 1 } })
    expect(keys).toHaveLength(2)
  })

  it('puts the inner effects and the stroke over it', () => {
    const shape = square()
    const paints = overPaints(shape, {
      innerShadow: shadow(),
      innerGlow: { size: 4, red: 1, green: 1, blue: 1, opacity: 1 },
      colorOverlay: { red: 1, green: 0, blue: 0, opacity: 1 },
      stroke: stroke(),
    })
    expect(paints.map((paint) => paint.color)).toEqual([
      [0, 0, 0],
      [1, 1, 1],
      [1, 0, 0],
      [0, 0, 0],
    ])
  })

  it('covers the whole shape with a colour overlay', () => {
    const shape = square()
    const overlay = overPaints(shape, { colorOverlay: { red: 1, green: 0, blue: 0, opacity: 1 } })[0]
    expect(maskCoverage(overlay.coverage)).toBeCloseTo(maskCoverage(shape), 6)
  })

  it('leaves out what is switched off', () => {
    const shape = square()
    expect(overPaints(shape, { stroke: { ...stroke(), enabled: false } })).toHaveLength(0)
  })

  it('draws nothing at all for an empty record', () => {
    const shape = square()
    expect(underPaints(shape, {})).toHaveLength(0)
    expect(overPaints(shape, {})).toHaveLength(0)
  })
})

describe('the defaults', () => {
  it('exist for every effect the format holds', () => {
    for (const key of EFFECT_ORDER) {
      const value = defaultEffect(key)
      expect(Object.keys(value).length).toBeGreaterThan(1)
      expect(value.enabled).toBeUndefined()
    }
  })

  it('start visible, which is how the format reads a missing enabled', () => {
    const effects: LayerEffects = { stroke: defaultEffect('stroke') as unknown as StrokeEffect }
    expect(overPaints(createMask(8, 8), effects)).toHaveLength(1)
  })
})
