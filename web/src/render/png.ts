/**
 * A grayscale PNG encoder.
 *
 * `canvas.convertToBlob` only ever produces RGBA, and a layer mask in a `.comp` is an 8-bit
 * grayscale PNG with no alpha — the format says so, and the loader refuses anything else. So masks
 * have to be encoded here rather than through the canvas.
 *
 * Only what a mask needs: 8-bit, colour type 0, one IDAT. `CompressionStream('deflate')` produces
 * the zlib stream PNG wants, so the deflate is the platform's rather than a hand-rolled one.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index)
  out.set(data, 8)
  const body = out.subarray(4, 8 + data.length)
  view.setUint32(8 + data.length, crc32(body))
  return out
}

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  // `deflate` is the zlib-wrapped variant, which is what a PNG IDAT holds.
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** One 8-bit sample per pixel, `width * height` of them, row-major from the top. */
export async function encodeGrayscalePng(
  width: number,
  height: number,
  samples: Uint8Array,
): Promise<Uint8Array> {
  // Each row is prefixed with its filter type, and 0 means "none". A mask is usually made of large
  // flat areas, where a filter would cost more than it saved.
  const raw = new Uint8Array((width + 1) * height)
  for (let row = 0; row < height; row += 1) {
    raw[row * (width + 1)] = 0
    raw.set(samples.subarray(row * width, (row + 1) * width), row * (width + 1) + 1)
  }

  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8 // bit depth
  header[9] = 0 // grayscale
  header[10] = 0 // compression
  header[11] = 0 // filter
  header[12] = 0 // interlace

  const parts = [
    new Uint8Array(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** The luminance of an RGBA buffer, which is how a mask surface is stored. */
export function grayscaleFromRgba(rgba: Uint8ClampedArray, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels)
  for (let index = 0; index < pixels; index += 1) {
    const at = index * 4
    // A mask is painted in grey, so the channels agree; the mean keeps a stray colour from
    // becoming a hole.
    out[index] = Math.round((rgba[at] + rgba[at + 1] + rgba[at + 2]) / 3)
  }
  return out
}
