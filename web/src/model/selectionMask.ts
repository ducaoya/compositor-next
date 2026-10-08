/**
 * The selection as an 8-bit coverage mask.
 *
 * A selection starts life as a *shape* — a rectangle, an ellipse, a lasso path — because that is
 * cheap to hit-test and cheap to clip against, and it is what the marquee tools produce. Feather,
 * Expand, Contract and the Magic Wand cannot be expressed as a shape at all, so they promote it to
 * a coverage mask at document resolution: 0 is outside, 255 is inside, and anything between is a
 * soft edge.
 *
 * Both representations live in one `Selection`, and the shape stays around when there is one so the
 * common case keeps its fast path. Everything here is a pure function on typed arrays, so the
 * arithmetic is testable without a canvas or a GPU.
 */

export interface Mask {
  width: number
  height: number
  data: Uint8Array
}

export function createMask(width: number, height: number, fill = 0): Mask {
  const data = new Uint8Array(Math.max(0, width * height))
  if (fill !== 0) data.fill(fill)
  return { width, height, data }
}

export function cloneMask(mask: Mask): Mask {
  return { width: mask.width, height: mask.height, data: Uint8Array.from(mask.data) }
}

/** A blank mask at the same size, for the operations that write into one. */
function sameSize(mask: Mask): Mask {
  return createMask(mask.width, mask.height)
}

const clampByte = (value: number): number => (value < 0 ? 0 : value > 255 ? 255 : value)

function clampIndex(value: number, count: number): number {
  return value < 0 ? 0 : value >= count ? count - 1 : value
}

// MARK: - Rasterising a shape

export interface ShapeBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The horizontal spans a convex row of a shape covers, as fractional pixel edges.
 *
 * Returning spans rather than setting pixels is what gives the edges a pixel of antialiasing for
 * free: the coverage of an end pixel is the fraction of it the span covers. Vertical resolution is
 * one sample per row, which is where a scanline fill always loses a little.
 */
function spansForRow(
  kind: 'rectangle' | 'ellipse' | 'polygon',
  row: number,
  bounds: ShapeBounds,
  points: readonly [number, number][],
): [number, number][] {
  const y = row + 0.5
  if (y < bounds.y || y > bounds.y + bounds.height) return []

  if (kind === 'rectangle') {
    return [[bounds.x, bounds.x + bounds.width]]
  }

  if (kind === 'ellipse') {
    const rx = bounds.width / 2
    const ry = bounds.height / 2
    const cy = bounds.y + ry
    const dy = (y - cy) / Math.max(ry, 1e-6)
    if (Math.abs(dy) > 1) return []
    const half = rx * Math.sqrt(Math.max(0, 1 - dy * dy))
    const cx = bounds.x + rx
    return [[cx - half, cx + half]]
  }

  // A polygon is filled by the even-odd rule, so its crossings come in pairs.
  const crossings: number[] = []
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if (yi > y !== yj > y) {
      crossings.push(((xj - xi) * (y - yi)) / (yj - yi) + xi)
    }
  }
  crossings.sort((a, b) => a - b)
  const spans: [number, number][] = []
  for (let index = 0; index + 1 < crossings.length; index += 2) {
    spans.push([crossings[index], crossings[index + 1]])
  }
  return spans
}

/** Rasterises a shape into a coverage mask, with the ends of each span antialiased. */
export function maskFromShape(
  shape: { kind: 'rectangle' | 'ellipse' | 'polygon'; bounds: ShapeBounds; points?: [number, number][] },
  width: number,
  height: number,
): Mask {
  const mask = createMask(width, height)
  const points = shape.points ?? []
  for (let row = 0; row < height; row += 1) {
    const spans = spansForRow(shape.kind, row, shape.bounds, points)
    if (spans.length === 0) continue
    const base = row * width
    for (const [from, to] of spans) {
      const start = Math.max(0, from)
      const end = Math.min(width, to)
      if (end <= start) continue
      const first = Math.floor(start)
      const last = Math.min(width - 1, Math.ceil(end) - 1)
      for (let x = first; x <= last; x += 1) {
        const overlap = Math.min(end, x + 1) - Math.max(start, x)
        if (overlap <= 0) continue
        mask.data[base + x] = clampByte(Math.round(overlap * 255))
      }
    }
  }
  return mask
}

// MARK: - Whole-mask operations

export function invertMask(mask: Mask): Mask {
  const out = sameSize(mask)
  for (let index = 0; index < mask.data.length; index += 1) {
    out.data[index] = 255 - mask.data[index]
  }
  return out
}

/**
 * The box radius whose three passes approximate a Gaussian of standard deviation `sigma`.
 *
 * The reference feathers with Core Image's Gaussian at `sigma = feather / 2`, so matching that is
 * what makes a Feather of 10 look the same here as there.
 */
export function boxRadiusForSigma(sigma: number): number {
  if (!(sigma > 0)) return 0
  return Math.max(0, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5))
}

/** One separable box pass, sliding a running sum so the cost does not grow with the radius. */
function boxPass(source: Uint8Array, width: number, height: number, radius: number, horizontal: boolean): Uint8Array {
  const out = new Uint8Array(source.length)
  const outer = horizontal ? height : width
  const inner = horizontal ? width : height
  const step = horizontal ? 1 : width
  const window = radius * 2 + 1

  for (let line = 0; line < outer; line += 1) {
    const base = horizontal ? line * width : line
    let sum = 0
    for (let i = -radius; i <= radius; i += 1) {
      sum += source[base + clampIndex(i, inner) * step]
    }
    for (let i = 0; i < inner; i += 1) {
      out[base + i * step] = Math.round(sum / window)
      sum -= source[base + clampIndex(i - radius, inner) * step]
      sum += source[base + clampIndex(i + radius + 1, inner) * step]
    }
  }
  return out
}

/** A feather: three box passes, which is the usual O(n) stand-in for a Gaussian. */
export function blurMask(mask: Mask, sigma: number): Mask {
  const radius = boxRadiusForSigma(sigma)
  if (radius < 1) return cloneMask(mask)
  let data = mask.data
  for (let pass = 0; pass < 3; pass += 1) {
    data = boxPass(data, mask.width, mask.height, radius, true)
    data = boxPass(data, mask.width, mask.height, radius, false)
  }
  return { width: mask.width, height: mask.height, data }
}

/** One separable max or min pass, for dilating and eroding. */
function rankPass(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
  maximum: boolean,
): Uint8Array {
  const out = new Uint8Array(source.length)
  const outer = horizontal ? height : width
  const inner = horizontal ? width : height
  const step = horizontal ? 1 : width

  for (let line = 0; line < outer; line += 1) {
    const base = horizontal ? line * width : line
    for (let i = 0; i < inner; i += 1) {
      let best = maximum ? 0 : 255
      const from = Math.max(0, i - radius)
      const to = Math.min(inner - 1, i + radius)
      for (let j = from; j <= to; j += 1) {
        const value = source[base + j * step]
        if (maximum ? value > best : value < best) best = value
      }
      out[base + i * step] = best
    }
  }
  return out
}

/**
 * Expands the selection by `amount` pixels.
 *
 * Separable max passes, which is a square structuring element rather than Photoshop's round one.
 * The difference is a corner of a few pixels on a shape with a sharp angle; a round one costs a
 * disc kernel and this does not.
 */
export function dilateMask(mask: Mask, amount: number): Mask {
  const radius = Math.max(0, Math.round(amount))
  if (radius < 1) return cloneMask(mask)
  const horizontal = rankPass(mask.data, mask.width, mask.height, radius, true, true)
  return { width: mask.width, height: mask.height, data: rankPass(horizontal, mask.width, mask.height, radius, false, true) }
}

export function erodeMask(mask: Mask, amount: number): Mask {
  const radius = Math.max(0, Math.round(amount))
  if (radius < 1) return cloneMask(mask)
  const horizontal = rankPass(mask.data, mask.width, mask.height, radius, true, false)
  return { width: mask.width, height: mask.height, data: rankPass(horizontal, mask.width, mask.height, radius, false, false) }
}

/** The smallest rectangle covering every set pixel, or null for an empty mask. */
export function maskBounds(mask: Mask): { x: number; y: number; width: number; height: number } | null {
  let minX = mask.width
  let minY = mask.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < mask.height; y += 1) {
    const base = y * mask.width
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[base + x] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

export function maskCoverage(mask: Mask): number {
  let total = 0
  for (let index = 0; index < mask.data.length; index += 1) total += mask.data[index]
  return total / (mask.data.length * 255)
}

// MARK: - The Magic Wand

/**
 * A flood fill from one pixel, as a coverage mask.
 *
 * `contiguous` is Photoshop's default: only pixels joined to the one clicked are taken. Without it
 * every pixel in the image within the tolerance is selected, which is the "global" wand.
 *
 * The comparison is against the pixel that was clicked rather than against each pixel's neighbour,
 * which is what keeps a gradient from leaking across the whole image.
 */
export function magicWandMask(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  tolerance: number,
  contiguous = true,
): Mask {
  const mask = createMask(width, height)
  const x0 = Math.floor(startX)
  const y0 = Math.floor(startY)
  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return mask

  const at = (x: number, y: number) => (y * width + x) * 4
  const seed = at(x0, y0)
  const target = [pixels[seed], pixels[seed + 1], pixels[seed + 2], pixels[seed + 3]]
  // A tolerance of 0 still has to accept the seed itself, which may be fully transparent.
  const limit = Math.max(0, Math.min(255, tolerance)) * 4 + 0.5

  const matches = (x: number, y: number): boolean => {
    const index = at(x, y)
    return (
      Math.abs(pixels[index] - target[0]) +
        Math.abs(pixels[index + 1] - target[1]) +
        Math.abs(pixels[index + 2] - target[2]) +
        Math.abs(pixels[index + 3] - target[3]) <=
      limit
    )
  }

  if (!contiguous) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (matches(x, y)) mask.data[y * width + x] = 255
      }
    }
    return mask
  }

  // An explicit stack rather than recursion: a 30,000-pixel-wide flat area would blow the call
  // stack long before it ran out of pixels.
  const seen = new Uint8Array(width * height)
  const stack: number[] = [y0 * width + x0]
  seen[y0 * width + x0] = 1
  while (stack.length > 0) {
    const index = stack.pop() as number
    const x = index % width
    const y = (index - x) / width
    if (!matches(x, y)) continue
    mask.data[index] = 255
    if (x > 0 && !seen[index - 1]) {
      seen[index - 1] = 1
      stack.push(index - 1)
    }
    if (x + 1 < width && !seen[index + 1]) {
      seen[index + 1] = 1
      stack.push(index + 1)
    }
    if (y > 0 && !seen[index - width]) {
      seen[index - width] = 1
      stack.push(index - width)
    }
    if (y + 1 < height && !seen[index + width]) {
      seen[index + width] = 1
      stack.push(index + width)
    }
  }
  return mask
}


/** How a new selection joins the one already there: Photoshop's four marquee modes. */
export type SelectionMode = 'new' | 'add' | 'subtract' | 'intersect'

/**
 * Combines two selections by coverage.
 *
 * Addition is the maximum of the two, intersection the minimum, and subtraction the first scaled
 * back by the second — the three operations that make sense on coverage, and the three Photoshop
 * offers. Everything is byte-wise and clamped, so a soft edge meets a soft edge softly.
 */
export function combineMasks(base: Mask | null, next: Mask, mode: SelectionMode): Mask {
  if (mode === 'new' || !base || base.width !== next.width || base.height !== next.height) {
    return cloneMask(next)
  }
  const out = sameSize(next)
  for (let index = 0; index < next.data.length; index += 1) {
    const a = base.data[index]
    const b = next.data[index]
    out.data[index] =
      mode === 'add'
        ? Math.max(a, b)
        : mode === 'intersect'
          ? Math.min(a, b)
          : Math.round(a * (1 - b / 255))
  }
  return out
}

/** A selection from a layer's own coverage: its alpha, thresholded. */
export function maskFromAlpha(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 128,
): Mask {
  const mask = createMask(width, height)
  for (let index = 0; index < width * height; index += 1) {
    mask.data[index] = rgba[index * 4 + 3] >= threshold ? 255 : 0
  }
  return mask
}
