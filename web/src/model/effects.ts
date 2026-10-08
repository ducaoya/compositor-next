/**
 * Layer effects: the six Photoshop draws around a layer's own pixels.
 *
 * Every one of them is a *coverage* question — where does the shadow fall, which pixels are inside
 * the stroke — so they are computed as mask algebra first and coloured afterwards. That keeps the
 * arithmetic separable from the pixels and, more usefully, testable without a canvas: a stroke is a
 * dilation minus the shape, an outer glow is a blur, an inner shadow is a blurred inverse clipped
 * to the shape.
 *
 * The settings are the reference app's, field for field, because they are what the `.comp` file
 * holds and a project has to render the same in both.
 */

import {
  blurMask,
  cloneMask,
  combineMasks,
  createMask,
  dilateMask,
  erodeMask,
  invertMask,
  type Mask,
} from './selectionMask'

export interface StrokeEffect {
  enabled?: boolean | null
  size: number
  red: number
  green: number
  blue: number
  opacity: number
  inside: boolean
}

export interface ShadowEffect {
  enabled?: boolean | null
  /** Degrees counterclockwise from the right, as Photoshop's dial is: 90 is from straight above. */
  angle: number
  distance: number
  blur: number
  red: number
  green: number
  blue: number
  opacity: number
}

export interface ColorOverlayEffect {
  enabled?: boolean | null
  red: number
  green: number
  blue: number
  opacity: number
}

export interface InnerShadowEffect {
  enabled?: boolean | null
  angle: number
  distance: number
  blur: number
  red: number
  green: number
  blue: number
  opacity: number
}

export interface OuterGlowEffect {
  enabled?: boolean | null
  size: number
  red: number
  green: number
  blue: number
  opacity: number
}

export interface InnerGlowEffect {
  enabled?: boolean | null
  size: number
  red: number
  green: number
  blue: number
  opacity: number
}

export interface LayerEffects {
  stroke?: StrokeEffect | null
  shadow?: ShadowEffect | null
  colorOverlay?: ColorOverlayEffect | null
  innerShadow?: InnerShadowEffect | null
  outerGlow?: OuterGlowEffect | null
  innerGlow?: InnerGlowEffect | null
  [key: string]: unknown
}

/** A `null` or missing `enabled` means visible, which is how the format reads it. */
function on(effect: { enabled?: boolean | null } | null | undefined): boolean {
  return effect != null && effect.enabled !== false
}

export const EFFECT_ORDER = ['stroke', 'shadow', 'colorOverlay', 'innerShadow', 'outerGlow', 'innerGlow'] as const
export type EffectKey = (typeof EFFECT_ORDER)[number]

/** Whether anything would actually be drawn. */
export function hasEffects(effects: LayerEffects | null | undefined): boolean {
  if (!effects) return false
  return EFFECT_ORDER.some((key) => on(effects[key] as { enabled?: boolean | null } | null))
}

/**
 * How far outside the layer's own rectangle the effects reach.
 *
 * The renderer grows the raster by this much on every side, which is why a shadow that falls
 * further than the margin allows would be clipped: the number has to be an upper bound, not an
 * estimate.
 */
export function effectsMargin(effects: LayerEffects | null | undefined): number {
  if (!effects) return 0
  const candidates: number[] = [0]
  const stroke = effects.stroke
  if (on(stroke) && stroke && !stroke.inside) candidates.push(stroke.size)
  const shadow = effects.shadow
  if (on(shadow) && shadow) candidates.push(Math.abs(shadow.distance) + shadow.blur)
  const glow = effects.outerGlow
  if (on(glow) && glow) candidates.push(glow.size)
  const margin = Math.max(...candidates)
  // The extra pixel absorbs the rounding, and is only added when there is something to round: an
  // empty record must ask for no growth at all, or every layer would grow a border.
  if (margin <= 0) return 0
  return Math.ceil(margin) + 1
}

/**
 * The shadow's offset in pixels.
 *
 * The angle is where the light comes from, counterclockwise from the right, so the shadow falls
 * *away* from it: light from the right at 0 degrees casts the shadow to the left, and light from
 * straight above at 90 degrees drops it straight down, because a layer's pixels count y downward.
 * Photoshop's own dial reads the same way.
 */
export function shadowOffset(effect: { angle: number; distance: number }): [number, number] {
  const radians = (effect.angle * Math.PI) / 180
  return [-Math.cos(radians) * effect.distance, Math.sin(radians) * effect.distance]
}

/** A mask moved by whole pixels, with the edge repeating rather than going transparent. */
export function shiftMask(mask: Mask, dx: number, dy: number): Mask {
  const wholeX = Math.round(dx)
  const wholeY = Math.round(dy)
  if (wholeX === 0 && wholeY === 0) return cloneMask(mask)
  const out = createMask(mask.width, mask.height)
  for (let y = 0; y < mask.height; y += 1) {
    const fromY = Math.min(mask.height - 1, Math.max(0, y - wholeY))
    for (let x = 0; x < mask.width; x += 1) {
      const fromX = Math.min(mask.width - 1, Math.max(0, x - wholeX))
      out.data[y * mask.width + x] = mask.data[fromY * mask.width + fromX]
    }
  }
  return out
}

/** Dilated then cut back to the shape: the band a stroke sits in, outside the edge. */
export function strokeCoverage(alpha: Mask, stroke: StrokeEffect): Mask {
  const size = Math.max(0, stroke.size)
  if (size <= 0) return createMask(alpha.width, alpha.height)
  const grown = stroke.inside ? erodeMask(alpha, size / 2) : dilateMask(alpha, size / 2)
  // Inside: what the erosion kept is the part the stroke covers. Outside: everything the dilation
  // added, which is the dilation minus the shape.
  return stroke.inside
    ? combineMasks(alpha, grown, 'subtract')
    : combineMasks(grown, alpha, 'subtract')
}

export function dropShadowCoverage(alpha: Mask, shadow: ShadowEffect): Mask {
  const [dx, dy] = shadowOffset(shadow)
  return blurMask(shiftMask(alpha, dx, dy), Math.max(0, shadow.blur) / 2)
}

export function outerGlowCoverage(alpha: Mask, glow: OuterGlowEffect): Mask {
  return blurMask(alpha, Math.max(0, glow.size) / 2)
}

/**
 * An inner shadow: the shape's inverse, shifted and blurred, kept to what is inside the shape.
 *
 * The inverse is what makes it an *inner* shadow — light comes from one side, so the shading
 * appears on the opposite inside edge.
 */
export function innerShadowCoverage(alpha: Mask, shadow: InnerShadowEffect): Mask {
  const [dx, dy] = shadowOffset(shadow)
  const outside = shiftMask(invertMask(alpha), dx, dy)
  return combineMasks(alpha, blurMask(outside, Math.max(0, shadow.blur) / 2), 'intersect')
}

export function innerGlowCoverage(alpha: Mask, glow: InnerGlowEffect): Mask {
  const outside = invertMask(alpha)
  return combineMasks(alpha, blurMask(outside, Math.max(0, glow.size) / 2), 'intersect')
}

/** The colour and how much of it each effect lays down, for the renderer. */
export interface EffectPaint {
  coverage: Mask
  color: [number, number, number]
  opacity: number
}

/** Every effect that draws *under* the layer, in the order Photoshop draws them. */
export function underPaints(alpha: Mask, effects: LayerEffects): EffectPaint[] {
  const paints: EffectPaint[] = []
  const shadow = effects.shadow
  if (on(shadow) && shadow) {
    paints.push({
      coverage: dropShadowCoverage(alpha, shadow),
      color: [shadow.red, shadow.green, shadow.blue],
      opacity: shadow.opacity,
    })
  }
  const glow = effects.outerGlow
  if (on(glow) && glow) {
    paints.push({
      coverage: outerGlowCoverage(alpha, glow),
      color: [glow.red, glow.green, glow.blue],
      opacity: glow.opacity,
    })
  }
  return paints
}

/** Every effect that draws *over* the layer, clipped to its shape. */
export function overPaints(alpha: Mask, effects: LayerEffects): EffectPaint[] {
  const paints: EffectPaint[] = []
  const innerShadow = effects.innerShadow
  if (on(innerShadow) && innerShadow) {
    paints.push({
      coverage: innerShadowCoverage(alpha, innerShadow),
      color: [innerShadow.red, innerShadow.green, innerShadow.blue],
      opacity: innerShadow.opacity,
    })
  }
  const glow = effects.innerGlow
  if (on(glow) && glow) {
    paints.push({
      coverage: innerGlowCoverage(alpha, glow),
      color: [glow.red, glow.green, glow.blue],
      opacity: glow.opacity,
    })
  }
  const overlay = effects.colorOverlay
  if (on(overlay) && overlay) {
    // A colour overlay covers the shape completely, so its coverage is the shape itself.
    paints.push({ coverage: cloneMask(alpha), color: [overlay.red, overlay.green, overlay.blue], opacity: overlay.opacity })
  }
  const stroke = effects.stroke
  if (on(stroke) && stroke) {
    paints.push({
      coverage: strokeCoverage(alpha, stroke),
      color: [stroke.red, stroke.green, stroke.blue],
      opacity: stroke.opacity,
    })
  }
  return paints
}

/** An identity effect of each kind, for the panel's Add menu. */
export function defaultEffect(key: EffectKey): Record<string, unknown> {
  switch (key) {
    case 'stroke':
      return { size: 4, red: 0, green: 0, blue: 0, opacity: 1, inside: false }
    case 'shadow':
      return { angle: 90, distance: 20, blur: 20, red: 0, green: 0, blue: 0, opacity: 0.5 }
    case 'colorOverlay':
      return { red: 1, green: 0.2, blue: 0.2, opacity: 1 }
    case 'innerShadow':
      return { angle: 90, distance: 10, blur: 10, red: 0, green: 0, blue: 0, opacity: 0.5 }
    case 'outerGlow':
      return { size: 20, red: 1, green: 1, blue: 1, opacity: 0.75 }
    case 'innerGlow':
      return { size: 12, red: 1, green: 1, blue: 1, opacity: 0.75 }
  }
}
