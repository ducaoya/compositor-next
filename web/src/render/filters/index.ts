/**
 * The finishing filters, as one entry point.
 *
 * Everything here is a pure function over typed arrays: no canvas, no GPU, no `document`. The caller
 * takes an `ImageData`'s bytes, calls one of these, and puts them back. That is what makes the
 * vignette, the tonal contrast, the lens correction, the noise and the glow testable without a
 * browser and without a GPU.
 */

export { type Bounds, type Rgba } from './types'
export { vignette, type VignetteSettings } from './vignette'
export { tonalContrast, type TonalSettings } from './tonalContrast'
export { lensDistort } from './lens'
export { addNoise, type NoiseSettings } from './noise'
export { dither, type DitherSettings } from './dither'
export { glow } from './bloom'
