/**
 * The retouch kernels, as one entry point.
 *
 * Everything here is a pure function over typed arrays: no canvas, no GPU, no `document`. The
 * caller takes an `ImageData`'s bytes, calls one of these, and puts them back. That is what makes
 * the smudge, the heal, the fill and the tone brushes testable without a browser.
 */

export { covers, type Bounds, type Rgba } from './types'
export { blurred, sharpened } from './blur'
export { smudgeDab, smudgePickUp, type SmudgeCarry } from './smudge'
export { coverageBounds, spotHeal } from './heal'
export { contentFill } from './contentFill'
export { dodgeBurn, sponge, toneWeight, type ToneRange } from './tone'
