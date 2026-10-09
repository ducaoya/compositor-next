/**
 * What this build can and cannot open, and how it opens the rest.
 *
 * The webview decodes whatever a browser decodes, and `createImageBitmap` refuses two formats an
 * editor is expected to open: SVG, because it is a vector, and TIFF, because a browser has no reader
 * for it. Both are handled here. Two more are not handled at all, and the reason is worth more than a
 * generic failure: RAW needs a decoder this project cannot legally ship (see `refusalFor`), and HEIC
 * needs the platform's own decoder, which only macOS has.
 *
 * Everything that goes wrong ends up as one of these three, because "it did not open" is not an
 * answer anyone can act on.
 */

import { readTiff, TiffError, type TiffProblem } from './tiff'

/** Why a file cannot be opened at all. */
export type ImportRefusal = 'raw' | 'heic' | 'tiff'

/** Photographs a decoder is needed for, and this build has none. */
const RAW_EXTENSIONS = new Set([
  '3fr', 'arw', 'cr2', 'cr3', 'crw', 'dcr', 'dng', 'erf', 'fff', 'iiq', 'k25', 'kdc', 'mef', 'mos',
  'mrw', 'nef', 'nrw', 'orf', 'pef', 'raf', 'raw', 'rw2', 'rwl', 'sr2', 'srf', 'srw', 'x3f',
])

/** The extension, lower case and without the dot, or an empty string. */
export function extensionOf(fileName: string): string {
  const match = /\.([^.\\/]+)$/.exec(fileName.trim())
  return match ? match[1].toLowerCase() : ''
}

/**
 * The reason this build cannot open a file, or null when it can try.
 *
 * RAW is refused on licensing rather than on effort. The reference app developed RAW through the
 * platform's imaging stack; the closest pure-Rust equivalent, `rawler`, is LGPL-2.1, and this project
 * is MIT — statically linking an LGPL library into it would make the whole binary LGPL, which is not
 * a decision a decoder should make on the project's behalf. So the file says no, and why, instead of
 * shipping a licence nobody agreed to.
 *
 * HEIC is refused on the platform's behalf: Windows' WIC has a HEIC decoder and the reference used
 * it, but reaching WIC from the Rust side is a project of its own, and a webview on Windows cannot
 * decode HEIC either. Until that exists, saying so is better than a file that opens to nothing.
 */
export function refusalFor(fileName: string): ImportRefusal | null {
  const extension = extensionOf(fileName)
  if (RAW_EXTENSIONS.has(extension)) return 'raw'
  if (extension === 'heic' || extension === 'heif' || extension === 'hif') return 'heic'
  return null
}

/** Why a file that this build tried to read did not open. */
export type ImportFailure =
  | { kind: 'refused'; reason: ImportRefusal }
  | { kind: 'tiff'; problem: TiffProblem }
  | { kind: 'undecodable' }

/**
 * A file as pixels.
 *
 * The order matters: a format this build refuses is refused before anything looks at its bytes, so
 * the answer does not depend on whether the file happens to be corrupt as well.
 */
export async function decodeImport(blob: Blob, fileName: string): Promise<ImageBitmap> {
  const refusal = refusalFor(fileName)
  if (refusal) throw new ImportError({ kind: 'refused', reason: refusal })

  const extension = extensionOf(fileName)
  if (extension === 'svg') return rasteriseSvg(blob)
  if (extension === 'tif' || extension === 'tiff') return rasteriseTiff(blob)

  try {
    return await createImageBitmap(blob)
  } catch {
    throw new ImportError({ kind: 'undecodable' })
  }
}

export class ImportError extends Error {
  readonly failure: ImportFailure

  constructor(failure: ImportFailure) {
    super(failure.kind === 'tiff' ? `tiff:${failure.problem}` : failure.kind)
    this.failure = failure
  }
}

/**
 * An SVG, drawn into a canvas and handed back as an image.
 *
 * `createImageBitmap` will not take a vector, but `drawImage` will: an `<img>` with an SVG source is
 * rasterised at whatever size it is drawn at, so the one place a vector can become pixels is a
 * canvas. The size comes from the file's own `width` and `height` where it states them, and from a
 * square default where it states only a view box — an SVG without a size has no intrinsic one, and
 * refusing it would mean refusing files that every browser displays perfectly well.
 */
async function rasteriseSvg(blob: Blob): Promise<ImageBitmap> {
  const text = await blob.text()
  const size = svgSize(text)
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
  try {
    const image = await loadImage(url)
    const canvas = new OffscreenCanvas(size.width, size.height)
    const context = canvas.getContext('2d')
    if (!context) throw new ImportError({ kind: 'undecodable' })
    context.drawImage(image, 0, 0, size.width, size.height)
    return await createImageBitmap(canvas)
  } catch (error) {
    if (error instanceof ImportError) throw error
    throw new ImportError({ kind: 'undecodable' })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * The size an SVG asks to be drawn at.
 *
 * A `width` and `height` in absolute units are taken as they are; percentages and `em`s are not, and
 * the view box is the fallback because it is in user units and always usable. The default is 1024
 * square, which is Photoshop's when it imports a vector with no size.
 */
export function svgSize(text: string, fallback = 1024): { width: number; height: number } {
  const open = /<svg\b[^>]*>/i.exec(text)
  if (!open) return { width: fallback, height: fallback }
  const attribute = (name: string): number | null => {
    // A plain number or a number of pixels. A percentage, an `em` or a physical unit is a size only
    // in a layout, and reading "100%" as a hundred pixels is how an icon ends up enormous.
    const match = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9]*\\.?[0-9]+)\\s*(?:px)?\\s*["']`, 'i').exec(open[0])
    if (!match) return null
    const value = Number.parseFloat(match[1])
    return Number.isFinite(value) && value > 0 ? value : null
  }
  const width = attribute('width')
  const height = attribute('height')
  if (width && height) return { width: Math.round(width), height: Math.round(height) }
  const viewBox = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(open[0])
  if (viewBox) {
    const parts = viewBox[1].trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: Math.round(parts[2]), height: Math.round(parts[3]) }
    }
  }
  return { width: fallback, height: fallback }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.addEventListener('load', () => resolve(image))
    image.addEventListener('error', () => reject(new Error('the SVG did not load')))
    image.src = url
  })
}

/**
 * A TIFF, read by this project's own reader and drawn into a canvas.
 *
 * The reader hands back straight RGBA, and a canvas is where an `ImageBitmap` has to come from, so
 * the buffer makes one trip through `putImageData`. `premultiplyAlpha: 'none'` keeps the colour
 * bytes exactly as the file had them, which matters for a TIFF with an alpha channel.
 */
async function rasteriseTiff(blob: Blob): Promise<ImageBitmap> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let pixels
  try {
    pixels = await readTiff(bytes)
  } catch (error) {
    throw new ImportError({
      kind: 'tiff',
      problem: error instanceof TiffError ? error.problem : 'truncated',
    })
  }
  const canvas = new OffscreenCanvas(pixels.width, pixels.height)
  const context = canvas.getContext('2d')
  if (!context) throw new ImportError({ kind: 'undecodable' })
  // The canvas wants a buffer with an `ArrayBuffer` of its own behind it; a reader is free to hand
  // back a view onto anything, so this one is copied on the way in.
  const pixels8 = new Uint8ClampedArray(pixels.data)
  context.putImageData(new ImageData(pixels8, pixels.width, pixels.height), 0, 0)
  return await createImageBitmap(canvas, { premultiplyAlpha: 'none' })
}
