/**
 * The shapes the retouch kernels work on, and the one predicate they all need.
 *
 * Everything here is deliberately free of the canvas: an `Rgba` is a plain rectangle of bytes so
 * the healing, filling and smudging maths can be tested without a GPU and without a browser, which
 * is the whole reason this module exists. The caller turns an `ImageData` into one of these and
 * turns it back, and nothing in between knows what a `document` is.
 */

/** A rectangle of pixels the way a canvas stores them: RGBA, eight bits a channel, top row first. */
export interface Rgba {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** Half-open pixel bounds: x to x + width, y to y + height. */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * True when the rectangle is inside the buffer.
 *
 * A negative extent is refused rather than treated as empty: a half-open rectangle only means
 * anything with a non-negative width and height, and a caller that computes one by subtracting the
 * wrong way round has a bug worth hearing about at the boundary instead of silently healing
 * nothing.
 */
export function covers(buffer: Rgba, bounds: Bounds): boolean {
  return (
    bounds.width >= 0 &&
    bounds.height >= 0 &&
    bounds.x >= 0 &&
    bounds.y >= 0 &&
    bounds.x + bounds.width <= buffer.width &&
    bounds.y + bounds.height <= buffer.height
  )
}
