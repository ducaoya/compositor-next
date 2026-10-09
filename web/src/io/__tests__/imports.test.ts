import { describe, expect, it } from 'vitest'

import { readTiff, TiffError, type TiffProblem } from '../tiff'
import { extensionOf, refusalFor, svgSize } from '../imports'

/**
 * Builds a classic TIFF from tag values and one strip of bytes.
 *
 * There are no TIFF files in this repository and this reader is the only thing that would read one,
 * so the fixtures are built here: a header, an IFD, whatever values do not fit in an entry, and the
 * strip. Two passes because a strip's offset tag has to name where the strip ends up, which is not
 * known until the values before it have been measured.
 */
function buildTiff(options: {
  little?: boolean
  tags: { tag: number; type: number; values: number[] }[]
  strip: Uint8Array
  extraTags?: { tag: number; type: number; values: number[] }[]
  magic?: number
}): Uint8Array {
  const little = options.little ?? true
  const count = options.tags.length + (options.extraTags?.length ?? 0)

  const sizeOf = (type: number): number => [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type] ?? 1
  const valueBytes = (entry: { type: number; values: number[] }): number =>
    sizeOf(entry.type) * entry.values.length

  const everything = [
    ...options.tags.map((entry) => entry),
    ...(options.extraTags ?? []),
  ]
  const ifdEnd = 8 + 2 + count * 12 + 4
  let extraAt = ifdEnd
  const extraOffsets = new Map<number, number>()
  everything.forEach((entry, index) => {
    const bytes = valueBytes(entry)
    if (bytes <= 4) return
    extraOffsets.set(index, extraAt)
    extraAt += bytes + (bytes % 2)
  })
  const stripOffset = extraAt
  const total = stripOffset + options.strip.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)

  const write16 = (at: number, value: number): void => view.setUint16(at, value, little)
  const write32 = (at: number, value: number): void => view.setUint32(at, value, little)

  write16(0, little ? 0x4949 : 0x4d4d)
  write16(2, options.magic ?? 42)
  write32(4, 8)
  write16(8, count)

  const put = (entry: { tag: number; type: number; values: number[] }, index: number, at: number): void => {
    write16(at, entry.tag)
    write16(at + 2, entry.type)
    write32(at + 4, entry.values.length)
    const bytes = valueBytes(entry)
    const where = bytes <= 4 ? at + 8 : (extraOffsets.get(index) ?? 0)
    // An entry whose value does not fit in four bytes points at it instead of holding it, which is
    // the one part of the layout that is easy to leave out and impossible to notice until every
    // value reads as zero.
    if (bytes > 4) write32(at + 8, where)
    entry.values.forEach((value, item) => {
      const target = where + item * sizeOf(entry.type)
      if (entry.type === 3) write16(target, value)
      else if (entry.type === 4) write32(target, value)
      else out[target] = value
    })
  }
  everything.forEach((entry, index) => put(entry, index, 10 + index * 12))
  write32(10 + count * 12, 0)
  out.set(options.strip, stripOffset)
  return out
}

/** The tags a minimal greyscale or RGB file needs, with the strip's own tags filled in. */
function basicTags(overrides: {
  width: number
  height: number
  bits: number
  samples: number
  photometric: number
  compression?: number
  stripBytes: number
  extra?: { tag: number; type: number; values: number[] }[]
}): { tag: number; type: number; values: number[] }[] {
  return [
    { tag: 256, type: 3, values: [overrides.width] },
    { tag: 257, type: 3, values: [overrides.height] },
    { tag: 258, type: 3, values: Array.from({ length: overrides.samples }, () => overrides.bits) },
    { tag: 259, type: 3, values: [overrides.compression ?? 1] },
    { tag: 262, type: 3, values: [overrides.photometric] },
    { tag: 273, type: 4, values: [0] },
    { tag: 277, type: 3, values: [overrides.samples] },
    { tag: 278, type: 3, values: [overrides.height] },
    { tag: 279, type: 4, values: [overrides.stripBytes] },
  ]
}

/** The same, with the strip offset patched to where the builder actually put it. */
function withStripOffset(tags: { tag: number; type: number; values: number[] }[]): {
  tags: { tag: number; type: number; values: number[] }[]
  stripOffset: number
} {
  // The strip always lands after the header, the IFD and any out-of-line values, and the only
  // out-of-line values in these fixtures are the colour table and the bits-per-sample list.
  let extra = 0
  for (const entry of tags) {
    const size = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][entry.type] ?? 1
    const bytes = size * entry.values.length
    if (bytes > 4) extra += bytes + (bytes % 2)
  }
  const stripOffset = 8 + 2 + tags.length * 12 + 4 + extra
  return { tags, stripOffset }
}

function tiffWithStrip(options: Parameters<typeof buildTiff>[0] & { tags: { tag: number; type: number; values: number[] }[] }): Uint8Array {
  const { tags, stripOffset } = withStripOffset(options.tags)
  const patched = tags.map((entry) => (entry.tag === 273 ? { ...entry, values: [stripOffset] } : entry))
  return buildTiff({ ...options, tags: patched })
}

/**
 * A zlib stream with one stored block: the format's own escape hatch for incompressible data.
 *
 * TIFF's Deflate is zlib, not raw deflate, so this carries the two-byte header and the Adler checksum
 * a zlib stream needs. The reader does not inflate anything itself — it hands the strip to the
 * platform's `DecompressionStream` — so what a Deflate case can test is the wiring rather than the
 * algorithm, and a stored block is the right size of fixture for that.
 */
function zlibStored(raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(raw.length + 11)
  out[0] = 0x78
  out[1] = 0x01
  out[2] = 0x01 // final block, no compression
  out[3] = raw.length & 0xff
  out[4] = raw.length >> 8
  out[5] = ~raw.length & 0xff
  out[6] = (~raw.length >> 8) & 0xff
  out.set(raw, 7)
  // Adler-32, big-endian, which is what a zlib stream ends with.
  let first = 1
  let second = 0
  for (const byte of raw) {
    first = (first + byte) % 65521
    second = (second + first) % 65521
  }
  const check = ((second << 16) | first) >>> 0
  const end = raw.length + 7
  out[end] = (check >>> 24) & 0xff
  out[end + 1] = (check >>> 16) & 0xff
  out[end + 2] = (check >>> 8) & 0xff
  out[end + 3] = check & 0xff
  return out
}

const problemOf = async (bytes: Uint8Array): Promise<TiffProblem> => {
  try {
    await readTiff(bytes)
  } catch (error) {
    if (error instanceof TiffError) return error.problem
    throw error
  }
  throw new Error('the file was read, and should not have been')
}

const at = (data: Uint8ClampedArray, width: number, x: number, y: number): number[] => {
  const index = (y * width + x) * 4
  return [data[index], data[index + 1], data[index + 2], data[index + 3]]
}

describe('what this build will not open', () => {
  it('refuses RAW by name, on the licence rather than on the effort', () => {
    for (const name of ['IMG_1234.CR2', 'shot.cr3', 'photo.NEF', 'wide.dng', 'x.raf', 'y.ORF']) {
      expect(refusalFor(name), name).toBe('raw')
    }
  })

  it('refuses HEIC, because no platform this build runs on has a decoder for it', () => {
    expect(refusalFor('IMG_0001.HEIC')).toBe('heic')
    expect(refusalFor('lift.heif')).toBe('heic')
  })

  it('lets everything else through to the decoder', () => {
    for (const name of ['a.png', 'b.JPG', 'c.webp', 'd.tif', 'e.tiff', 'f.svg', 'no-extension']) {
      expect(refusalFor(name), name).toBeNull()
    }
  })

  it('reads the extension the same way however the path is written', () => {
    expect(extensionOf('C:\\photos\\a.CR2')).toBe('cr2')
    expect(extensionOf('/home/me/a.TIFF')).toBe('tiff')
    expect(extensionOf('archive.tar.gz')).toBe('gz')
    expect(extensionOf('plain')).toBe('')
  })
})

describe('an SVG\u2019s size', () => {
  it('uses its own width and height when it states them', () => {
    expect(svgSize('<svg width="64" height="48"></svg>')).toEqual({ width: 64, height: 48 })
  })

  it('falls back to the view box, which is the only size a vector has to have', () => {
    expect(svgSize('<svg viewBox="0 0 120 90"></svg>')).toEqual({ width: 120, height: 90 })
  })

  it('takes a square default when it states neither', () => {
    // A file with no size has no intrinsic one, and every browser displays it perfectly well, so
    // refusing it would refuse files that work everywhere else.
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 512)).toEqual({ width: 512, height: 512 })
    expect(svgSize('not an svg at all', 256)).toEqual({ width: 256, height: 256 })
  })

  it('ignores a percentage, which is a size only in a layout', () => {
    expect(svgSize('<svg width="100%" height="100%" viewBox="0 0 40 30"></svg>')).toEqual({ width: 40, height: 30 })
  })
})

describe('reading a TIFF', () => {
  it('reads an uncompressed RGB file pixel for pixel', async () => {
    const strip = new Uint8Array([
      255, 0, 0, 0, 255, 0,
      0, 0, 255, 255, 255, 0,
    ])
    const bytes = tiffWithStrip({
      tags: basicTags({ width: 2, height: 2, bits: 8, samples: 3, photometric: 2, stripBytes: strip.length }),
      strip,
    })
    const image = await readTiff(bytes)
    expect([image.width, image.height]).toEqual([2, 2])
    expect(at(image.data, 2, 0, 0)).toEqual([255, 0, 0, 255])
    expect(at(image.data, 2, 1, 0)).toEqual([0, 255, 0, 255])
    expect(at(image.data, 2, 0, 1)).toEqual([0, 0, 255, 255])
    expect(at(image.data, 2, 1, 1)).toEqual([255, 255, 0, 255])
  })

  it('reads the same picture from either byte order', async () => {
    const strip = new Uint8Array([10, 20, 30, 40, 50, 60])
    const little = await readTiff(
      tiffWithStrip({
        little: true,
        tags: basicTags({ width: 2, height: 1, bits: 8, samples: 3, photometric: 2, stripBytes: 6 }),
        strip,
      }),
    )
    const big = await readTiff(
      tiffWithStrip({
        little: false,
        tags: basicTags({ width: 2, height: 1, bits: 8, samples: 3, photometric: 2, stripBytes: 6 }),
        strip,
      }),
    )
    expect([...big.data]).toEqual([...little.data])
  })

  it('expands a one-bit greyscale file, four pixels to a byte', async () => {
    // 0b1010_0000 is white, black, white, black, then four whites: packed samples run from the
    // most significant bit down, which is the opposite order from the file byte order.
    const bytes = tiffWithStrip({
      tags: basicTags({ width: 8, height: 1, bits: 1, samples: 1, photometric: 1, stripBytes: 1 }),
      strip: new Uint8Array([0b10100000]),
    })
    const image = await readTiff(bytes)
    expect([
      at(image.data, 8, 0, 0)[0],
      at(image.data, 8, 1, 0)[0],
      at(image.data, 8, 2, 0)[0],
      at(image.data, 8, 7, 0)[0],
    ]).toEqual([255, 0, 255, 0])
  })

  it('scales a sixteen-bit sample by its high byte rather than truncating it', async () => {
    // 0xFF80 is a byte with a hundred and twenty-eight thousandths, which is 255 as a byte.
    const bytes = tiffWithStrip({
      tags: basicTags({ width: 2, height: 1, bits: 16, samples: 1, photometric: 1, stripBytes: 4 }),
      strip: new Uint8Array([0x80, 0xff, 0x00, 0x40]),
    })
    const image = await readTiff(bytes)
    expect([at(image.data, 2, 0, 0)[0], at(image.data, 2, 1, 0)[0]]).toEqual([255, 64])
  })

  it('inverts a WhiteIsZero file, which stores zero as white', async () => {
    const bytes = tiffWithStrip({
      tags: basicTags({ width: 2, height: 1, bits: 8, samples: 1, photometric: 0, stripBytes: 2 }),
      strip: new Uint8Array([0, 255]),
    })
    const image = await readTiff(bytes)
    expect([at(image.data, 2, 0, 0)[0], at(image.data, 2, 1, 0)[0]]).toEqual([255, 0])
  })

  it('maps a palette file through its colour table', async () => {
    const table = [65535, 0, 0, 65535, 0, 65535, 0, 65535, 0, 0, 65535, 65535]
    const bytes = tiffWithStrip({
      tags: [
        ...basicTags({ width: 2, height: 1, bits: 8, samples: 1, photometric: 3, stripBytes: 2 }),
        { tag: 320, type: 3, values: table },
      ],
      strip: new Uint8Array([0, 1]),
    })
    const image = await readTiff(bytes)
    // Three planes of four: red, green, blue, white. The reader shifts by eight because a colour
    // table is sixteen bits a channel and a canvas is eight.
    expect(at(image.data, 2, 0, 0)).toEqual([255, 0, 0, 255])
    expect(at(image.data, 2, 1, 0)).toEqual([0, 255, 0, 255])
  })

  it('undoes PackBits, both a run and a literal stretch', async () => {
    // 0x02 then three literals, then 0xFD meaning three copies of the byte after it.
    const bytes = tiffWithStrip({
      tags: basicTags({ width: 6, height: 1, bits: 8, samples: 1, photometric: 1, stripBytes: 6, compression: 32773 }),
      strip: new Uint8Array([0x02, 1, 2, 3, 0xfd, 9]),
    })
    const image = await readTiff(bytes)
    const levels = [0, 1, 2, 3, 4, 5].map((x) => at(image.data, 6, x, 0)[0])
    expect(levels).toEqual([1, 2, 3, 9, 9, 9])
  })

  it('undoes a horizontal predictor along each row', async () => {
    // Stored as differences from the pixel to the left, per channel.
    const bytes = tiffWithStrip({
      tags: [
        ...basicTags({ width: 3, height: 2, bits: 8, samples: 1, photometric: 1, stripBytes: 6 }),
        { tag: 317, type: 3, values: [2] },
      ],
      strip: new Uint8Array([10, 10, 10, 20, 20, 20]),
    })
    const image = await readTiff(bytes)
    expect([0, 1, 2].map((x) => at(image.data, 3, x, 0)[0])).toEqual([10, 20, 30])
    // The second row restarts rather than continuing the first: that is what makes it a *row*
    // predictor, and getting it wrong is a diagonal smear down the picture.
    expect([0, 1, 2].map((x) => at(image.data, 3, x, 1)[0])).toEqual([20, 40, 60])
  })

  it('reads a strip of several rows as one image', async () => {
    const strip = new Uint8Array([1, 2, 2, 3])
    const bytes = tiffWithStrip({
      tags: basicTags({ width: 2, height: 2, bits: 8, samples: 1, photometric: 1, stripBytes: 4 }),
      strip,
    })
    const image = await readTiff(bytes)
    expect([0, 1].map((x) => at(image.data, 2, x, 0)[0])).toEqual([1, 2])
    expect([0, 1].map((x) => at(image.data, 2, x, 1)[0])).toEqual([2, 3])
  })

  it('reads a Deflate-compressed strip', async () => {
    const raw = new Uint8Array([5, 6, 7, 8])
    const strip = zlibStored(raw)
    const bytes = tiffWithStrip({
      tags: basicTags({ width: 4, height: 1, bits: 8, samples: 1, photometric: 1, stripBytes: strip.length, compression: 8 }),
      strip,
    })
    const image = await readTiff(bytes)
    expect([0, 1, 2, 3].map((x) => at(image.data, 4, x, 0)[0])).toEqual([5, 6, 7, 8])
  })

  it('reads an LZW-compressed strip', async () => {
    const raw = new Uint8Array(Array.from({ length: 40 }, (_, index) => (index * 7) % 251))
    const strip = lzwEncode(raw)
    const bytes = tiffWithStrip({
      tags: basicTags({ width: 40, height: 1, bits: 8, samples: 1, photometric: 1, stripBytes: strip.length, compression: 5 }),
      strip,
    })
    const image = await readTiff(bytes)
    expect([...Array.from({ length: 40 }, (_, x) => at(image.data, 40, x, 0)[0])]).toEqual([...raw])
  })

  it('crosses the LZW code-width changes, which is where a nearly-right reader breaks', async () => {
    // Enough distinct data that the dictionary passes five hundred and eleven entries: the width
    // goes from nine bits to ten one code *early*, and a reader that grows it late diverges here
    // rather than at the end.
    const raw = new Uint8Array(Array.from({ length: 1024 }, (_, index) => (index * 37 + (index >> 3)) & 0xff))
    const strip = lzwEncode(raw)
    const bytes = tiffWithStrip({
      tags: basicTags({ width: 1024, height: 1, bits: 8, samples: 1, photometric: 1, stripBytes: strip.length, compression: 5 }),
      strip,
    })
    const image = await readTiff(bytes)
    expect([...Array.from({ length: 1024 }, (_, x) => at(image.data, 1024, x, 0)[0])]).toEqual([...raw])
  })
})

/**
 * A TIFF-LZW encoder, written from the same description as the reader.
 *
 * Both sides are this project's, so a round trip alone cannot catch a rule the two agree on and the
 * format does not; what it does catch is the reader drifting from the encoder, and the width
 * transition is in here because a stream that crosses it is the only one that tests it at all.
 */
function lzwEncode(input: Uint8Array): Uint8Array {
  const out: number[] = []
  let current = 0
  let bits = 0
  let width = 9
  let next = 258
  const dictionary = new Map<string, number>()

  const emit = (code: number): void => {
    for (let index = width - 1; index >= 0; index -= 1) {
      current = (current << 1) | ((code >> index) & 1)
      bits += 1
      if (bits === 8) {
        out.push(current & 0xff)
        current = 0
        bits = 0
      }
    }
  }
  const codeOf = (phrase: string): number =>
    phrase.length === 1 ? phrase.charCodeAt(0) : (dictionary.get(phrase) ?? phrase.charCodeAt(0))
  const reset = (): void => {
    dictionary.clear()
    next = 258
    width = 9
  }

  reset()
  emit(256)
  let phrase = ''
  for (const value of input) {
    const character = String.fromCharCode(value)
    if (phrase === '') {
      phrase = character
      continue
    }
    const candidate = phrase + character
    if (dictionary.has(candidate)) {
      phrase = candidate
      continue
    }
    emit(codeOf(phrase))
    dictionary.set(candidate, next)
    next += 1
    // The width grows one code early, which is what makes this TIFF's LZW rather than the GIF
    // variant: a stream that crosses five hundred and eleven entries only decodes if both sides
    // agree about when the tenth bit starts.
    if (next + 1 > 1 << width && width < 12) width += 1
    if (next >= 4096) {
      emit(256)
      reset()
    }
    phrase = character
  }
  if (phrase !== '') emit(codeOf(phrase))
  emit(257)
  if (bits > 0) out.push(current << (8 - bits))
  return new Uint8Array(out)
}

describe('a TIFF this reader cannot read', () => {
  it('says a BigTIFF is a layout it does not know rather than reading it as a classic one', async () => {
    const bytes = tiffWithStrip({
      tags: basicTags({ width: 1, height: 1, bits: 8, samples: 1, photometric: 1, stripBytes: 1 }),
      strip: new Uint8Array([1]),
      magic: 43,
    })
    expect(await problemOf(bytes)).toBe('unsupported-layout')
  })

  it('names the compression it does not have', async () => {
    const bytes = tiffWithStrip({
      tags: basicTags({ width: 1, height: 1, bits: 8, samples: 1, photometric: 1, stripBytes: 1, compression: 7 }),
      strip: new Uint8Array([1]),
    })
    expect(await problemOf(bytes)).toBe('unsupported-compression')
  })

  it('names a tiled file, which is a layout this reader does not walk', async () => {
    const bytes = tiffWithStrip({
      tags: [
        ...basicTags({ width: 1, height: 1, bits: 8, samples: 1, photometric: 1, stripBytes: 1 }),
        { tag: 322, type: 3, values: [16] },
      ],
      strip: new Uint8Array([1]),
    })
    expect(await problemOf(bytes)).toBe('unsupported-layout')
  })

  it('refuses a file that claims more bytes than it has, rather than reading past the end', async () => {
    const bytes = tiffWithStrip({
      tags: basicTags({ width: 4, height: 4, bits: 8, samples: 3, photometric: 2, stripBytes: 48 }),
      strip: new Uint8Array([1, 2, 3]),
    })
    expect(await problemOf(bytes)).toBe('truncated')
  })

  it('refuses something that is not a TIFF at all', async () => {
    expect(await problemOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe('not-tiff')
    expect(await problemOf(new Uint8Array([0x49, 0x49]))).toBe('truncated')
  })

  it('refuses a YCbCr file, which needs a colour conversion this reader does not do', async () => {
    const bytes = tiffWithStrip({
      tags: basicTags({ width: 1, height: 1, bits: 8, samples: 3, photometric: 6, stripBytes: 3 }),
      strip: new Uint8Array([1, 2, 3]),
    })
    expect(await problemOf(bytes)).toBe('unsupported-samples')
  })

  it('refuses a floating-point predictor', async () => {
    const bytes = tiffWithStrip({
      tags: [
        ...basicTags({ width: 1, height: 1, bits: 8, samples: 1, photometric: 1, stripBytes: 4 }),
        { tag: 317, type: 3, values: [3] },
      ],
      strip: new Uint8Array([1, 2, 3, 4]),
    })
    expect(await problemOf(bytes)).toBe('bad-predictor')
  })
})
