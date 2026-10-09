/**
 * A TIFF reader.
 *
 * The macOS reference got TIFF from the platform's imaging stack and a browser has no reader for it,
 * so this project reads it itself. That means saying exactly what is supported rather than appearing
 * to support everything: the subsets below are the ones files in the wild actually use, and anything
 * outside them is refused by name, because a file that opens to a wrong-looking picture is worse
 * than a file that says it cannot be opened.
 *
 * Supported: both byte orders; the first image of the first IFD; strips; no compression, PackBits,
 * LZW (with TIFF's early-change rule) and Deflate; greyscale, RGB, RGBA, palette and CMYK; 1, 2, 4, 8
 * and 16 bits a sample; the horizontal predictor.
 *
 * Not supported: BigTIFF (magic 43), tiles, JPEG and CCITT compression, YCbCr, floating-point
 * samples, predictor 3, and the second and later images in a multi-page file. Each is refused with
 * the reason rather than misread.
 *
 * Orientation is read past rather than applied: the app's own layer transform is where a picture is
 * rotated, and honouring the tag here as well would rotate it twice. Resolution and any colour
 * profile are ignored for the same reason — the first is the app's business and the second is a
 * managed colour question this format's bytes cannot answer on their own.
 */

/** A rectangle of pixels the way a canvas stores them: RGBA, eight bits a channel, top row first. */
export interface Rgba {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** What went wrong, in the terms a caller has to report it in. */
export type TiffProblem =
  | 'not-tiff'
  | 'truncated'
  | 'unsupported-compression'
  | 'unsupported-layout'
  | 'unsupported-samples'
  | 'bad-predictor'

export class TiffError extends Error {
  readonly problem: TiffProblem

  constructor(problem: TiffProblem) {
    super(`tiff:${problem}`)
    this.problem = problem
  }
}

/** The tag numbers this reader reads, named so the code below says what it means. */
const TAG = {
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  photometric: 262,
  stripOffsets: 273,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  planarConfiguration: 284,
  predictor: 317,
  colorMap: 320,
  tileWidth: 322,
  extraSamples: 338,
} as const

interface Entry {
  type: number
  count: number
  /** The values themselves, read through the entry's type and offset. */
  values: number[]
  /** Where the value bytes are, for the ones that are blobs rather than numbers. */
  offset: number
}

/** How many bytes each TIFF type takes, indexed by type. Zero marks a type this reader has no use for. */
const TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8]

export async function readTiff(bytes: Uint8Array): Promise<Rgba> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 8) throw new TiffError('truncated')
  const order = view.getUint16(0, false)
  // 0x4949 is "II" on a little-endian machine and 0x4D4D is "MM" on a big one, and the only way to
  // know how to read the magic is to have read the order, which is why it is two bytes rather than
  // one. BigTIFF's 43 is refused by name: it has 64-bit offsets, and reading it as classic TIFF
  // would produce convincing nonsense.
  const little = order === 0x4949
  if (!little && order !== 0x4d4d) throw new TiffError('not-tiff')
  const magic = view.getUint16(2, little)
  if (magic === 43) throw new TiffError('unsupported-layout')
  if (magic !== 42) throw new TiffError('not-tiff')

  const ifdOffset = view.getUint32(4, little)
  if (ifdOffset + 2 > bytes.byteLength) throw new TiffError('truncated')
  const count = view.getUint16(ifdOffset, little)
  const entries = new Map<number, Entry>()
  for (let index = 0; index < count; index += 1) {
    const at = ifdOffset + 2 + index * 12
    if (at + 12 > bytes.byteLength) throw new TiffError('truncated')
    const tag = view.getUint16(at, little)
    const type = view.getUint16(at + 2, little)
    const length = view.getUint32(at + 4, little)
    const size = TYPE_SIZES[type] ?? 0
    if (!size) continue
    const total = size * length
    const offset = total <= 4 ? at + 8 : view.getUint32(at + 8, little)
    if (offset + total > bytes.byteLength) throw new TiffError('truncated')
    const values: number[] = []
    for (let item = 0; item < length; item += 1) values.push(readValue(view, offset, type, item, little))
    entries.set(tag, { type, count: length, values, offset })
  }

  const number = (tag: number, fallback: number): number => entries.get(tag)?.values[0] ?? fallback
  const numbers = (tag: number): number[] => entries.get(tag)?.values ?? []

  const width = number(TAG.imageWidth, 0)
  const height = number(TAG.imageLength, 0)
  if (width <= 0 || height <= 0) throw new TiffError('unsupported-layout')
  // A second image is a second page, and this reader opens the first. Saying so is better than
  // silently returning page one of a document someone expected to be complete.
  if (entries.has(TAG.tileWidth)) throw new TiffError('unsupported-layout')

  const compression = number(TAG.compression, 1)
  const photometric = number(TAG.photometric, 1)
  const samplesPerPixel = number(TAG.samplesPerPixel, 1)
  const predictor = number(TAG.predictor, 1)
  if (number(TAG.planarConfiguration, 1) !== 1) throw new TiffError('unsupported-layout')
  if (predictor !== 1 && predictor !== 2) throw new TiffError('bad-predictor')
  if (photometric !== 0 && photometric !== 1 && photometric !== 2 && photometric !== 3 && photometric !== 4 && photometric !== 5) {
    throw new TiffError('unsupported-samples')
  }
  if (samplesPerPixel !== 1 && samplesPerPixel !== 3 && samplesPerPixel !== 4) {
    throw new TiffError('unsupported-samples')
  }

  const bits = numbers(TAG.bitsPerSample)
  const bitsPerSample = bits.length > 0 ? bits[0] : 1
  if (bits.length > 1 && bits.some((value) => value !== bitsPerSample)) {
    throw new TiffError('unsupported-samples')
  }
  if (![1, 2, 4, 8, 16].includes(bitsPerSample)) throw new TiffError('unsupported-samples')

  const offsets = numbers(TAG.stripOffsets)
  const counts = numbers(TAG.stripByteCounts)
  if (offsets.length === 0 || offsets.length !== counts.length) throw new TiffError('unsupported-layout')

  const rowsPerStrip = number(TAG.rowsPerStrip, height)
  const stride = Math.ceil((width * samplesPerPixel * bitsPerSample) / 8)
  const out = new Uint8ClampedArray(width * height * 4)
  const colorMap = numbers(TAG.colorMap)
  // A fourth sample is alpha when `ExtraSamples` says so, and when the tag is missing (which is
  // common) it is still safer to treat it as alpha: a file with an unused fourth channel loses
  // nothing, while a file with a real alpha channel read as opaque shows the background it was cut
  // out of.
  const hasAlpha = samplesPerPixel === 4 && photometric === 2
  const greyscale = photometric === 0 || photometric === 1 || photometric === 4
  const inverted = photometric === 0 || photometric === 4

  let written = 0
  for (let strip = 0; strip < offsets.length; strip += 1) {
    const rows = Math.min(rowsPerStrip, height - strip * rowsPerStrip)
    if (rows <= 0) break
    const raw = await decompress(bytes, offsets[strip], counts[strip], compression, stride * rows)
    const decoded = predictor === 2 ? undoHorizontalPredictor(raw, width, rows, samplesPerPixel, bitsPerSample, little) : raw
    for (let row = 0; row < rows; row += 1) {
      const target = (written + row) * width
      for (let x = 0; x < width; x += 1) {
        const pixel = target + x
        // The sample index is counted from the strip's start, not from the row's: a strip holds
        // several rows end to end, and reading row two from row one's bytes is the bug this
        // indexing exists to prevent.
        const first = (row * width + x) * samplesPerPixel
        if (greyscale) {
          const value = sampleAt(decoded, first, bitsPerSample, little)
          const level = scaleSample(value, bitsPerSample)
          const grey = inverted ? 255 - level : level
          out[pixel * 4] = grey
          out[pixel * 4 + 1] = grey
          out[pixel * 4 + 2] = grey
          out[pixel * 4 + 3] = 255
          continue
        }
        if (photometric === 3) {
          const index = scaleSample(sampleAt(decoded, first, bitsPerSample, little), bitsPerSample)
          const half = colorMap.length / 3
          out[pixel * 4] = colorMap[index] !== undefined ? colorMap[index] >> 8 : 0
          out[pixel * 4 + 1] = colorMap[half + index] !== undefined ? colorMap[half + index] >> 8 : 0
          out[pixel * 4 + 2] = colorMap[2 * half + index] !== undefined ? colorMap[2 * half + index] >> 8 : 0
          out[pixel * 4 + 3] = 255
          continue
        }
        const channels: number[] = []
        for (let channel = 0; channel < samplesPerPixel; channel += 1) {
          channels.push(scaleSample(sampleAt(decoded, first + channel, bitsPerSample, little), bitsPerSample))
        }
        if (photometric === 5) {
          // CMYK, the way every other reader converts it: the ink is subtracted from white.
          const [c, m, y, k] = channels
          out[pixel * 4] = 255 - Math.min(255, c + k)
          out[pixel * 4 + 1] = 255 - Math.min(255, m + k)
          out[pixel * 4 + 2] = 255 - Math.min(255, y + k)
          out[pixel * 4 + 3] = 255
          continue
        }
        out[pixel * 4] = channels[0]
        out[pixel * 4 + 1] = channels[1]
        out[pixel * 4 + 2] = channels[2]
        out[pixel * 4 + 3] = hasAlpha ? channels[3] : 255
      }
    }
    written += rows
  }
  return { data: out, width, height }
}

/** One value out of an entry's bytes, read through the type the entry declares. */
function readValue(view: DataView, offset: number, type: number, index: number, little: boolean): number {
  switch (type) {
    case 1:
    case 6:
    case 7:
      return view.getUint8(offset + index)
    case 3:
      return view.getUint16(offset + index * 2, little)
    case 4:
      return view.getUint32(offset + index * 4, little)
    case 8:
      return view.getInt16(offset + index * 2, little)
    case 9:
      return view.getInt32(offset + index * 4, little)
    default:
      return 0
  }
}

/** One sample out of a strip, counted from the strip's first byte. */
function sampleAt(data: Uint8Array, index: number, bitsPerSample: number, little: boolean): number {
  if (bitsPerSample === 8) return data[index] ?? 0
  if (bitsPerSample === 16) {
    const at = index * 2
    if (at + 1 >= data.length) return 0
    return little ? (data[at] | (data[at + 1] << 8)) : ((data[at] << 8) | data[at + 1])
  }
  // Packed sub-byte samples run left to right in a byte, most significant first, which is the
  // opposite order from the byte order the file declares.
  const perByte = 8 / bitsPerSample
  const at = Math.floor(index / perByte)
  const shift = 8 - bitsPerSample * (index % perByte + 1)
  return ((data[at] ?? 0) >> shift) & ((1 << bitsPerSample) - 1)
}

/** A sample scaled to a byte. Sixteen bits go by their high byte, which is the round in the file. */
function scaleSample(value: number, bitsPerSample: number): number {
  if (bitsPerSample === 16) return value >> 8
  if (bitsPerSample === 8) return value
  return Math.round((value / ((1 << bitsPerSample) - 1)) * 255)
}

/**
 * One strip's bytes, decompressed.
 *
 * LZW is TIFF's own variant of the algorithm: nine-bit codes to start, a clear code at 256 and an
 * end code at 257, and the code width growing one code *early* at 511, 1023 and 2047. Early change
 * is the part that is easy to get wrong, and getting it wrong produces a picture that is almost
 * right, which is why the tests cross those boundaries rather than trusting a round trip.
 */
function decompress(
  bytes: Uint8Array,
  offset: number,
  count: number,
  compression: number,
  expected: number,
): Uint8Array | Promise<Uint8Array> {
  if (offset + count > bytes.byteLength) throw new TiffError('truncated')
  const input = bytes.subarray(offset, offset + count)
  switch (compression) {
    case 1:
      return input
    case 32773:
      return unpackBits(input, expected)
    case 5:
      return inflateLzw(input, expected)
    case 8:
    case 32946:
      return inflateDeflate(input, expected)
    default:
      throw new TiffError('unsupported-compression')
  }
}

function unpackBits(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected)
  let written = 0
  let at = 0
  while (at < input.length && written < expected) {
    const header = input[at] < 128 ? input[at] : input[at] - 256
    at += 1
    if (header >= 0) {
      for (let index = 0; index <= header && at < input.length && written < expected; index += 1) {
        out[written] = input[at]
        written += 1
        at += 1
      }
    } else if (header !== -128) {
      const value = input[at] ?? 0
      at += 1
      for (let index = 0; index < 1 - header && written < expected; index += 1) {
        out[written] = value
        written += 1
      }
    }
  }
  return out
}

/** TIFF's LZW: a dictionary that grows, and a code width that grows one code early. */
function inflateLzw(input: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected)
  let written = 0
  let bit = 0
  const clear = 256
  const end = 257
  let dictionary: number[][] = []
  let width = 9
  let previous: number[] | null = null

  const reset = (): void => {
    dictionary = []
    for (let index = 0; index < 256; index += 1) dictionary.push([index])
    dictionary.push([], [])
    width = 9
    previous = null
  }
  reset()

  const nextCode = (): number => {
    let value = 0
    for (let index = 0; index < width; index += 1) {
      const byte = bit >> 3
      if (byte >= input.length) return end
      const taken = (input[byte] >> (7 - (bit & 7))) & 1
      value = (value << 1) | taken
      bit += 1
    }
    return value
  }

  for (;;) {
    const code = nextCode()
    if (code === end) break
    if (code === clear) {
      reset()
      continue
    }
    let entry: number[]
    if (dictionary[code]) entry = dictionary[code].slice()
    else if (previous) entry = [...previous, previous[0]]
    else throw new TiffError('unsupported-compression')
    for (const value of entry) {
      if (written >= out.length) break
      out[written] = value
      written += 1
    }
    if (previous && dictionary.length < 4096) dictionary.push([...previous, entry[0]])
    previous = entry
    // The early-change rule: the width grows one code before the dictionary is full, so a stream
    // written that way and read any other way diverges at 511 rather than at 512.
    if (dictionary.length + 1 >= 1 << width && width < 12) width += 1
  }
  return out
}

/**
 * Deflate, through the platform's own decompressor.
 *
 * `DecompressionStream` is a stream, and a strip is a byte range, so the bytes go in one end and are
drained out the other. That makes this the one asynchronous part of reading a TIFF, which is why
 * `readTiff` returns a promise: the alternative is four hundred lines of Huffman tables for
 * something every runtime this app runs on already has.
 */
async function inflateDeflate(input: Uint8Array, expected: number): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate')
  const writer = stream.writable.getWriter()
  // The write and the close are not awaited: a `DecompressionStream` only produces output once it is
  // asked for it, so waiting for these first would deadlock.
  void writer.write(new Uint8Array(input))
  void writer.close()
  const out = new Uint8Array(expected)
  let written = 0
  const reader = stream.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = value as Uint8Array
    const take = Math.min(chunk.length, out.length - written)
    out.set(chunk.subarray(0, take), written)
    written += take
    if (written >= out.length) break
  }
  return out
}

/**
 * The horizontal predictor, undone.
 *
 * Each sample on a row is the difference from the sample one pixel to its left, so undoing it is a
 * running sum along the row. It is applied per row and per channel, and it must be undone *before*
 * the samples are unpacked, because the difference is of the stored values rather than of the scaled
 * ones.
 */
function undoHorizontalPredictor(
  data: Uint8Array,
  width: number,
  rows: number,
  samplesPerPixel: number,
  bitsPerSample: number,
  little: boolean,
): Uint8Array {
  const out = new Uint8Array(data)
  const stride = Math.ceil((width * samplesPerPixel * bitsPerSample) / 8)
  if (bitsPerSample !== 8 && bitsPerSample !== 16) throw new TiffError('bad-predictor')
  for (let row = 0; row < rows; row += 1) {
    for (let x = 1; x < width; x += 1) {
      for (let channel = 0; channel < samplesPerPixel; channel += 1) {
        const index = x * samplesPerPixel + channel
        const before = (x - 1) * samplesPerPixel + channel
        if (bitsPerSample === 8) {
          out[row * stride + index] = ((data[row * stride + index] ?? 0) + (out[row * stride + before] ?? 0)) & 0xff
        } else {
          const at = row * stride + index * 2
          const earlier = row * stride + before * 2
          const current = little ? (data[at] | (data[at + 1] << 8)) : ((data[at] << 8) | data[at + 1])
          const prior = little
            ? (out[earlier] | (out[earlier + 1] << 8))
            : ((out[earlier] << 8) | out[earlier + 1])
          const sum = (current + prior) & 0xffff
          out[at] = little ? sum & 0xff : sum >> 8
          out[at + 1] = little ? sum >> 8 : sum & 0xff
        }
      }
    }
  }
  return out
}
