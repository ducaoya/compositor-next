/**
 * The shapes the finishing filters work on.
 *
 * This mirrors `web/src/render/retouch/types.ts` rather than importing it, because the two modules
 * are meant to stand apart: the retouch kernels are brushes that paint, and these are whole-image
 * passes, and keeping a copy here means neither one's edits can surprise the other. The types are
 * structurally identical, so a buffer built for one is accepted by the other, and `blurred()` in
 * the retouch module can be handed one of these directly. The shared `covers` predicate is
 * deliberately *not* copied: nothing in the filters needs it, and a second copy would be a second
 * place for the half-open rule to drift.
 */

/** A rectangle of pixels the way a canvas stores them: RGBA, eight bits a channel, top row first. */
export interface Rgba {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** A rectangle in pixels: x by y, width by height. */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
