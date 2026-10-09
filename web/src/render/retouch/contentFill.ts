/**
 * Content-aware fill, on the CPU.
 *
 * A faithful port of `Compositor/Rendering/ContentFill.c`: every selected pixel takes its colour
 * from the unselected opaque pixel elsewhere in the image whose 5×5 neighbourhood best matches
 * what is already around the hole, working outwards from the selection's edge so each filled pixel
 * becomes donor material for the next. The LCG, the 5×5 (or 1×1 on a tiny image) match window, the
 * coarse-to-fine refinement of 64, 32, 16, 8, 4, 2, 1 pixels, and the second pass that starts a
 * selection only transparency touches from the best random donor are all the reference's.
 *
 * As in `HealPixels.c`, the reference works on **premultiplied** bytes while a caller here gets
 * straight alpha from `getImageData`. The pixels are used exactly as given, with the reference's
 * arithmetic, so the only difference shows on a translucent layer; a premultiplication round trip
 * would perturb every opaque pixel instead.
 *
 * The return value is the caller-visible one, not the reference's status code: the reference
 * answers "no donor exists" with 1 when the mask was empty, but a fill that selected nothing has
 * nothing to report, so this returns false for it and for a mask that covers everything.
 */

import type { Rgba } from './types'

/**
 * Mean squared colour difference between the neighbourhood of a hole pixel and of a donor.
 *
 * Only pixels already known are compared on the hole's side — the reference's rule — so the score
 * measures how well the donor continues what is already there rather than how it compares to the
 * still-unknown pixels being filled. A neighbourhood with nothing known scores as worthless rather
 * than as a perfect zero, which is what keeps such a donor from being picked.
 */
function match(
  pixels: Rgba,
  stride: number,
  known: Uint8Array,
  width: number,
  height: number,
  hole: number,
  donor: number,
  radius: number,
): number {
  const holeX = hole % width
  const holeY = Math.floor(hole / width)
  const donorX = donor % width
  const donorY = Math.floor(donor / width)
  let count = 0
  let sum = 0
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = holeX + dx
      const y = holeY + dy
      const sx = donorX + dx
      const sy = donorY + dy
      if (x < 0 || y < 0 || x >= width || y >= height) continue
      if (sx < 0 || sy < 0 || sx >= width || sy >= height || !known[y * width + x]) continue
      const a = y * stride + x * 4
      const b = sy * stride + sx * 4
      for (let channel = 0; channel < 4; channel += 1) {
        const difference = pixels.data[a + channel] - pixels.data[b + channel]
        sum += difference * difference
      }
      count += 1
    }
  }
  return count ? sum / count : Number.MAX_VALUE
}

/** Content-aware fill, in place. Returns false when there is no patch to copy from. */
export function contentFill(pixels: Rgba, mask: Uint8ClampedArray): boolean {
  const width = pixels.width
  const height = pixels.height
  const stride = width * 4
  const count = width * height
  const known = new Uint8Array(count)
  const target = new Uint8Array(count)
  const valid = new Uint8Array(count)
  const queued = new Uint8Array(count)
  const donors = new Int32Array(count)
  const queue = new Int32Array(count)
  const chosen = new Int32Array(count)
  chosen.fill(-1)

  // A 5×5 neighbourhood needs a 2-pixel radius, which a tiny buffer cannot supply; the reference
  // drops to a single pixel there rather than clipping the window unevenly.
  const radius = width >= 5 && height >= 5 ? 2 : 0

  let missing = 0
  let donorCount = 0
  let head = 0
  let tail = 0
  let scan = 0

  // Selected pixels are to be filled. Unselected opaque pixels are the image to match and copy
  // from. Unselected transparent ones are neither: there is nothing there to match, and they are
  // left exactly as they are.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * width + x
      const selected = mask[y * width + x] !== 0
      target[at] = selected ? 1 : 0
      known[at] = !selected && pixels.data[y * stride + x * 4 + 3] === 255 ? 1 : 0
      if (selected) missing += 1
    }
  }
  if (missing === 0) return false

  // A donor has to be surrounded by known pixels, or copying it would drag a hole edge into the
  // result.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * width + x
      if (!known[at]) continue
      let sound = true
      for (let dy = -radius; dy <= radius && sound; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sx = x + dx
          const sy = y + dy
          if (sx < 0 || sy < 0 || sx >= width || sy >= height || !known[sy * width + sx]) {
            sound = false
            break
          }
        }
      }
      if (sound) {
        valid[at] = 1
        donors[donorCount] = at
        donorCount += 1
      }
    }
  }
  if (!donorCount) return false

  // The fill spreads from the selection's edge inwards, so every pixel it reaches has known
  // neighbours to match against.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * width + x
      if (!target[at]) continue
      const touchesKnown =
        (x > 0 && known[at - 1]) ||
        (x + 1 < width && known[at + 1]) ||
        (y > 0 && known[at - width]) ||
        (y + 1 < height && known[at + width])
      if (touchesKnown) {
        queue[tail] = at
        tail += 1
        queued[at] = 1
      }
    }
  }

  let seed = 0x6d2b79f5
  const nextRandom = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed
  }

  for (;;) {
    while (head < tail) {
      const hole = queue[head]
      head += 1
      const x = hole % width
      const y = Math.floor(hole / width)
      let best = -1
      let score = Number.MAX_VALUE
      const neighbours = [
        x ? hole - 1 : -1,
        x + 1 < width ? hole + 1 : -1,
        y ? hole - width : -1,
        y + 1 < height ? hole + width : -1,
      ]
      // First propagate the coherent source offset from a filled neighbour — that is what keeps a
      // straight edge straight — then refine with a randomised search over the whole donor set.
      for (let k = 0; k < 28; k += 1) {
        let donor = -1
        if (k < 4) {
          const neighbour = neighbours[k]
          if (neighbour >= 0) donor = (chosen[neighbour] >= 0 ? chosen[neighbour] : neighbour) + (hole - neighbour)
        } else {
          donor = donors[nextRandom() % donorCount]
        }
        if (donor < 0 || donor >= count || !valid[donor]) continue
        const candidate = match(pixels, stride, known, width, height, hole, donor, radius)
        if (best < 0 || candidate < score) {
          score = candidate
          best = donor
        }
      }
      if (best < 0) best = donors[0]
      // Coarse to fine: try a donor far from the current best, then halve the radius until the
      // search is a single pixel. This is what lines repeating texture up to sub-pixel accuracy.
      for (let r = 64; r >= 1; r = Math.floor(r / 2)) {
        const qx = (best % width) + (nextRandom() % (2 * r + 1)) - r
        const qy = Math.floor(best / width) + (nextRandom() % (2 * r + 1)) - r
        if (qx < 0 || qy < 0 || qx >= width || qy >= height || !valid[qy * width + qx]) continue
        const donor = qy * width + qx
        const candidate = match(pixels, stride, known, width, height, hole, donor, radius)
        if (candidate < score) {
          score = candidate
          best = donor
        }
      }
      const destination = y * stride + x * 4
      const source = Math.floor(best / width) * stride + (best % width) * 4
      for (let channel = 0; channel < 4; channel += 1) pixels.data[destination + channel] = pixels.data[source + channel]
      known[hole] = 1
      chosen[hole] = best
      for (let k = 0; k < 4; k += 1) {
        const neighbour = neighbours[k]
        if (neighbour >= 0 && target[neighbour] && !known[neighbour] && !queued[neighbour]) {
          queued[neighbour] = 1
          queue[tail] = neighbour
          tail += 1
        }
      }
    }

    // A selection that only transparency touches has no known neighbour to start from, so it starts
    // from the best random donor and spreads from there.
    while (scan < count && (!target[scan] || known[scan])) scan += 1
    if (scan >= count) break
    queue[tail] = scan
    tail += 1
    queued[scan] = 1
  }

  return donorCount > 0
}
