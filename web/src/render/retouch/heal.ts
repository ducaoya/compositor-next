/**
 * Spot healing, on the CPU.
 *
 * A faithful port of `Compositor/Rendering/HealPixels.c`. The structure is the reference's: find
 * the bounds of the painted coverage, grow a ring of untouched pixels around it, look for a patch
 * of the image elsewhere whose ring best matches that ring, solve a membrane (the edge difference
 * between the spot and the patch, spread smoothly across the spot) and composite the healed patch
 * back by coverage times opacity. Create Texture mode skips the search, fills smoothly from the
 * edge and adds grain matched to the detail around the spot.
 *
 * The reference's arithmetic is kept as-is, including the LCG-free hash for the grain, the
 * coarse-to-fine pyramid with over-relaxation in the membrane solve, and the 24-angle patch
 * search with its five distance factors. Two things are worth knowing before reading:
 *
 * First, the reference operates on **premultiplied** RGBA (that is what its canvas holds), while a
 * caller here gets straight-alpha bytes from `getImageData`. This port works on the bytes exactly
 * as given, with the reference's arithmetic untouched. That is the one place it knowingly differs:
 * it only shows where a layer is translucent, and inventing a premultiplication round trip would
 * change every opaque pixel's numbers, which is a much worse trade than a slightly wrong heal on a
 * half-transparent layer.
 *
 * Second, the reference returns a status code, not whether anything was healed. Here an empty
 * coverage, or one whose ring of good pixels is entirely off the image, returns false so the caller
 * can say nothing was painted; the reference cannot distinguish those from success.
 */

import type { Bounds, Rgba } from './types'

const OUTSIDE = 0
const RING = 1
const HOLE = 2

/** Rounds half away from zero, the way C's `lround` does, which `Math.round` only matches for
 *  positives. Used for the search offsets so a patch can land on the same pixel the reference's did. */
function lround(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/**
 * The reference's integer hash, bit for bit.
 *
 * Every step is 32-bit: `Math.imul` for the multiplies, and `>>> 0` at the end to present the
 * result as an unsigned value the way the C's `uint32_t` return does. A drift here would not
 * crash anything — it would just make the same seed produce different grain, which is exactly the
 * kind of bug that is invisible until someone reopens a project.
 */
function healHash(x: number): number {
  let value = x >>> 0
  value = (value ^ (value >>> 16)) >>> 0
  value = Math.imul(value, 0x7feb352d) >>> 0
  value = (value ^ (value >>> 15)) >>> 0
  value = Math.imul(value, 0x846ca68b) >>> 0
  value = (value ^ (value >>> 16)) >>> 0
  return value >>> 0
}

/** The hash read as a number in [0, 1), which is what the grain's two draws need. */
function healUnit(key: number): number {
  return (healHash(key) >>> 8) / 16777216
}

/**
 * Mean squared ring difference between the spot and the patch offset by (dx, dy).
 *
 * Infinite when the patch would overlap the spot (so the heal never copies the pixels it is
 * healing) or would leave the image. Only ring pixels are compared, and the sum is divided by the
 * count of ring pixels rather than of channels, which is the reference's weighting.
 */
function healScore(
  pixels: Rgba,
  stride: number,
  role: Uint8Array,
  originX: number,
  originY: number,
  width: number,
  height: number,
  dx: number,
  dy: number,
  imageWidth: number,
  imageHeight: number,
): number {
  if (Math.abs(dx) < width && Math.abs(dy) < height) return Infinity
  if (
    originX + dx < 0 ||
    originY + dy < 0 ||
    originX + width + dx > imageWidth ||
    originY + height + dy > imageHeight
  ) {
    return Infinity
  }
  let sum = 0
  let count = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (role[y * width + x] !== RING) continue
      const target = (originY + y) * stride + (originX + x) * 4
      const source = (originY + y + dy) * stride + (originX + x + dx) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        const difference = pixels.data[target + channel] - pixels.data[source + channel]
        sum += difference * difference
      }
      count += 1
    }
  }
  return count ? sum / count : Infinity
}

/**
 * Solves for smooth values over the hole, held fixed to the ring around it.
 *
 * A coarser copy is solved first and used as the starting point — that is what lets a large spot
 * settle in forty passes instead of three hundred — then the full-resolution solve over-relaxes
 * with omega 1.8, which converges faster than plain Gauss–Seidel without ringing on this kind of
 * problem. The pyramid bottoms out at the reference's depth of sixteen, so a spot larger than any
 * brush cannot recurse without end.
 *
 * The reference stores values in 32-bit floats; this does too, through `Float32Array`, so the two
 * settle to the same numbers rather than merely close ones.
 */
function healSolve(value: Float32Array, role: Uint8Array, width: number, height: number, depth: number): void {
  let iterations = 300
  if (width > 32 && height > 32 && depth < 16) {
    const coarseWidth = Math.floor((width + 1) / 2)
    const coarseHeight = Math.floor((height + 1) / 2)
    const coarse = new Float32Array(coarseWidth * coarseHeight * 4)
    const coarseRole = new Uint8Array(coarseWidth * coarseHeight)
    for (let y = 0; y < coarseHeight; y += 1) {
      for (let x = 0; x < coarseWidth; x += 1) {
        let known = 0
        let hole = 0
        const knownSum = [0, 0, 0, 0]
        const holeSum = [0, 0, 0, 0]
        for (let j = 0; j < 2; j += 1) {
          for (let i = 0; i < 2; i += 1) {
            const fineX = x * 2 + i
            const fineY = y * 2 + j
            if (fineX >= width || fineY >= height) continue
            const fine = fineY * width + fineX
            if (role[fine] === RING) {
              known += 1
              for (let channel = 0; channel < 4; channel += 1) knownSum[channel] += value[fine * 4 + channel]
            } else if (role[fine] === HOLE) {
              hole += 1
              for (let channel = 0; channel < 4; channel += 1) holeSum[channel] += value[fine * 4 + channel]
            }
          }
        }
        const at = y * coarseWidth + x
        if (known) {
          coarseRole[at] = RING
          for (let channel = 0; channel < 4; channel += 1) coarse[at * 4 + channel] = knownSum[channel] / known
        } else if (hole) {
          coarseRole[at] = HOLE
          for (let channel = 0; channel < 4; channel += 1) coarse[at * 4 + channel] = holeSum[channel] / hole
        }
      }
    }
    healSolve(coarse, coarseRole, coarseWidth, coarseHeight, depth + 1)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const fine = y * width + x
        const at = Math.floor(y / 2) * coarseWidth + Math.floor(x / 2)
        if (role[fine] === HOLE && coarseRole[at] === HOLE) {
          for (let channel = 0; channel < 4; channel += 1) value[fine * 4 + channel] = coarse[at * 4 + channel]
        }
      }
    }
    iterations = 40
  }

  const omega = 1.8
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = y * width + x
        if (role[at] !== HOLE) continue
        const sum = [0, 0, 0, 0]
        let count = 0
        const neighbours = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ]
        for (const [nx, ny] of neighbours) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const neighbour = ny * width + nx
          if (role[neighbour] === OUTSIDE) continue
          for (let channel = 0; channel < 4; channel += 1) sum[channel] += value[neighbour * 4 + channel]
          count += 1
        }
        if (!count) continue
        for (let channel = 0; channel < 4; channel += 1) {
          value[at * 4 + channel] += omega * (sum[channel] / count - value[at * 4 + channel])
        }
      }
    }
  }
}

/** The half-open bounds of the non-zero bytes of a coverage mask, or null when it is all zero. */
export function coverageBounds(coverage: Uint8ClampedArray, width: number, height: number): Bounds | null {
  let left = width
  let top = height
  let right = 0
  let bottom = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!coverage[y * width + x]) continue
      if (x < left) left = x
      if (x + 1 > right) right = x + 1
      if (y < top) top = y
      if (y + 1 > bottom) bottom = y + 1
    }
  }
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Spot healing, in place. `coverage` is width × height bytes, 0…255, marking what to heal.
 *
 * mode 0 is content-aware (copy the best-matching patch and heal the seam), 1 create texture (no
 * search: fill smoothly from the edge and add grain), 2 proximity match (like content-aware but
 * biased towards near patches). Returns false when the coverage was empty, so the caller can say
 * nothing was painted.
 */
export function spotHeal(
  pixels: Rgba,
  coverage: Uint8ClampedArray,
  opacity: number,
  mode: 0 | 1 | 2,
  seed: number,
): boolean {
  const imageWidth = pixels.width
  const imageHeight = pixels.height
  const stride = imageWidth * 4
  const bounds = coverageBounds(coverage, imageWidth, imageHeight)
  if (!bounds) return false

  const size = Math.max(bounds.width, bounds.height)
  let ring = Math.floor(size / 8)
  if (ring < 2) ring = 2
  if (ring > 16) ring = 16

  // The work box: the spot plus its ring, clipped to the image.
  const originX = Math.max(0, bounds.x - ring)
  const originY = Math.max(0, bounds.y - ring)
  const right = Math.min(imageWidth, bounds.x + bounds.width + ring)
  const bottom = Math.min(imageHeight, bounds.y + bounds.height + ring)
  const width = right - originX
  const height = bottom - originY
  const boxSize = width * height
  if (width <= 0 || height <= 0) return false

  const role = new Uint8Array(boxSize)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      role[y * width + x] = coverage[(originY + y) * imageWidth + originX + x] ? HOLE : OUTSIDE
    }
  }

  // The ring is a square dilation of the hole, done as a row pass then a column pass so the cost
  // does not depend on the ring's width. Pixels within `ring` of any hole pixel on both axes are
  // the ring; the hole itself stays the hole.
  const near = new Uint8Array(boxSize)
  const prefix = new Int32Array(Math.max(width, height) + 1)
  for (let y = 0; y < height; y += 1) {
    prefix[0] = 0
    for (let x = 0; x < width; x += 1) prefix[x + 1] = prefix[x] + (role[y * width + x] === HOLE ? 1 : 0)
    for (let x = 0; x < width; x += 1) {
      const low = x - ring < 0 ? 0 : x - ring
      const high = x + ring + 1 > width ? width : x + ring + 1
      near[y * width + x] = prefix[high] - prefix[low] > 0 ? 1 : 0
    }
  }
  for (let x = 0; x < width; x += 1) {
    prefix[0] = 0
    for (let y = 0; y < height; y += 1) prefix[y + 1] = prefix[y] + near[y * width + x]
    for (let y = 0; y < height; y += 1) {
      const low = y - ring < 0 ? 0 : y - ring
      const high = y + ring + 1 > height ? height : y + ring + 1
      if (role[y * width + x] === OUTSIDE && prefix[high] - prefix[low] > 0) role[y * width + x] = RING
    }
  }

  let ringCount = 0
  for (let at = 0; at < boxSize; at += 1) ringCount += role[at] === RING ? 1 : 0
  if (!ringCount) return false

  // The source patch, for content-aware and proximity match. The factors are the reference's: a
  // patch about one spot away, out to nearly three, tried at each of twenty-four angles. Nearer
  // patches win ties, more strongly in proximity mode.
  let offsetX = 0
  let offsetY = 0
  let haveSource = false
  if (mode !== 1) {
    const factors = [1.05, 1.35, 1.75, 2.25, 2.8]
    const count = mode === 2 ? 2 : 5
    let best = Infinity
    for (let f = 0; f < count; f += 1) {
      for (let a = 0; a < 24; a += 1) {
        const angle = (a * Math.PI) / 12
        const dx = lround(Math.cos(angle) * factors[f] * width)
        const dy = lround(Math.sin(angle) * factors[f] * height)
        let score = healScore(pixels, stride, role, originX, originY, width, height, dx, dy, imageWidth, imageHeight)
        if (!Number.isFinite(score)) continue
        score *= mode === 2 ? 1 + 0.6 * f : 1 + 0.1 * f
        if (score < best) {
          best = score
          offsetX = dx
          offsetY = dy
        }
      }
    }
    if (Number.isFinite(best)) {
      // Fine-tune the alignment so repeating texture lines up.
      const centreX = offsetX
      const centreY = offsetY
      let refined = healScore(pixels, stride, role, originX, originY, width, height, centreX, centreY, imageWidth, imageHeight)
      for (let j = -3; j <= 3; j += 1) {
        for (let i = -3; i <= 3; i += 1) {
          const score = healScore(
            pixels,
            stride,
            role,
            originX,
            originY,
            width,
            height,
            centreX + i,
            centreY + j,
            imageWidth,
            imageHeight,
          )
          if (score < refined) {
            refined = score
            offsetX = centreX + i
            offsetY = centreY + j
          }
        }
      }
      haveSource = true
    }
  }

  // The membrane: along the ring, the difference between the original and the patch. Spread across
  // the hole it is exactly what makes copied texture meet the surrounding tone without a seam.
  // With no patch the same difference is taken against black, so the fill is a smooth ramp from the
  // ring's own tone, and the detail around the spot is measured separately for the grain.
  const value = new Float32Array(boxSize * 4)
  const mean = [0, 0, 0, 0]
  const detail = [0, 0, 0]
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * width + x
      if (role[at] !== RING) continue
      const ix = originX + x
      const iy = originY + y
      const target = iy * stride + ix * 4
      const source = haveSource ? (iy + offsetY) * stride + (ix + offsetX) * 4 : -1
      for (let channel = 0; channel < 4; channel += 1) {
        const difference = pixels.data[target + channel] - (haveSource ? pixels.data[source + channel] : 0)
        value[at * 4 + channel] = difference
        mean[channel] += difference
      }
      if (!haveSource) {
        for (let channel = 0; channel < 3; channel += 1) {
          let around = 0
          let count = 0
          const neighbours = [
            [ix - 1, iy],
            [ix + 1, iy],
            [ix, iy - 1],
            [ix, iy + 1],
          ]
          for (const [nx, ny] of neighbours) {
            if (nx < 0 || ny < 0 || nx >= imageWidth || ny >= imageHeight) continue
            around += pixels.data[ny * stride + nx * 4 + channel]
            count += 1
          }
          if (count) {
            const difference = pixels.data[target + channel] - around / count
            detail[channel] += difference * difference
          }
        }
      }
    }
  }
  for (let channel = 0; channel < 4; channel += 1) mean[channel] /= ringCount
  for (let at = 0; at < boxSize; at += 1) {
    if (role[at] !== HOLE) continue
    for (let channel = 0; channel < 4; channel += 1) value[at * 4 + channel] = mean[channel]
  }
  healSolve(value, role, width, height, 0)
  for (let channel = 0; channel < 3; channel += 1) detail[channel] = Math.sqrt(detail[channel] / ringCount) * 0.9

  // The composite: the healed pixel, replaced by coverage times opacity, with the grain only where
  // there was no patch to carry the texture.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * width + x
      if (role[at] !== HOLE) continue
      const ix = originX + x
      const iy = originY + y
      const target = iy * stride + ix * 4
      const source = haveSource ? (iy + offsetY) * stride + (ix + offsetX) * 4 : -1
      const amount = (coverage[iy * imageWidth + ix] / 255) * opacity
      let grain = 0
      if (!haveSource) {
        const key = (seed ^ healHash((iy * imageWidth + ix) >>> 0)) >>> 0
        const u1 = healUnit(key)
        const u2 = healUnit((key ^ 0x68e31da4) >>> 0)
        grain = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2)
      }
      const out = [0, 0, 0, 0]
      for (let channel = 0; channel < 4; channel += 1) {
        const healed =
          (haveSource ? pixels.data[source + channel] : 0) +
          value[at * 4 + channel] +
          (channel < 3 ? grain * detail[channel] : 0)
        out[channel] = pixels.data[target + channel] + (healed - pixels.data[target + channel]) * amount
      }
      const alpha = out[3] < 0 ? 0 : out[3] > 255 ? 255 : out[3]
      pixels.data[target + 3] = lround(alpha)
      for (let channel = 0; channel < 3; channel += 1) {
        const clamped = out[channel] < 0 ? 0 : out[channel] > pixels.data[target + 3] ? pixels.data[target + 3] : out[channel]
        pixels.data[target + channel] = lround(clamped)
      }
    }
  }
  return true
}
