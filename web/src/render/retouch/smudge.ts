/**
 * The Smudge tool, on the CPU.
 *
 * Ported from `WarpStroke.smudge(at:)`, `weight(_:)` and `pickUp(at:)` in
 * `Compositor/Document/SmudgeLiquify.swift`. Only the smudge path is here: the Liquify forward
 * warp and every Metal path in that file belong to the GPU stroke the reference runs, and this
 * module has no GPU.
 *
 * The tool is a drag, not a stamp. One dab lays down what the brush carried from the previous dab,
 * then picks up what it has just left, so a stroke moves one patch of colour along with it rather
 * than stencilling copies of the first pick-up everywhere. `pickUp` is the exception: it seeds the
 * carry for the first dab of a stroke, when there is nothing to carry yet.
 *
 * The carry patch is indexed relative to the dab's centre, not to a fixed canvas origin, which is
 * what makes it travel with the brush — the reference's `c = ((dy + r) * side + dx + r) * 4`. That
 * indexing is preserved here because it is the tool.
 *
 * The reference computes in Swift `Float`s; this uses ordinary JavaScript numbers, which are
 * wider, so a half-byte tie can round the other way. Nothing else differs: the falloff, the offset
 * indexing and the `invR` normalisation are the reference's. `invR` is `1 / (diameter / 2)`, and
 * since the reference's `radius` is `ceil(diameter / 2)` this file's `radius` doubles as the
 * reference's radius, giving `diameter = radius * 2` and `invR = 1 / radius`. It is computed from
 * the caller's radius rather than re-derived, so a caller that passes a rounded radius gets the
 * same normalisation the reference stroke did.
 *
 * The reference clamps hardness to 0.98 and strength into 0.01…1 when it builds a stroke. Here the
 * kernels take what they are given, clamped into 0…1, because both are documented as that range —
 * strength 0 is then exactly the identity, which is more useful to a caller than a silent floor.
 */

import type { Rgba } from './types'

/** The patch a smudge stroke carries from one dab to the next. */
export interface SmudgeCarry {
  /** side by side RGBA, in floats so a long stroke does not quantize. */
  readonly data: Float32Array
  readonly side: number
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * How much a dab moves pixels at a distance `u` from its centre, 0 at the centre and 1 at the rim.
 *
 * Solid out to `hardness`, then a smoothstep to nothing at the rim. Smoothstep rather than a line
 * so the soft edge has no visible ridge where the two pieces meet. A point exactly on the rim
 * contributes nothing, and a NaN distance (which a radius of zero would produce) is treated the
 * same way rather than propagating a NaN into the pixels.
 */
function weight(u: number, hardness: number): number {
  if (!(u < 1)) return 0
  if (u <= hardness) return 1
  const t = (1 - u) / (1 - hardness)
  return t * t * (3 - 2 * t)
}

/** Lifts the patch under a point out of the buffer, for the first dab of a stroke. */
export function smudgePickUp(target: Rgba, centre: [number, number], radius: number): SmudgeCarry {
  const r = Math.max(0, Math.round(radius))
  const side = 2 * r + 1
  const data = new Float32Array(side * side * 4)
  const centreX = Math.round(centre[0])
  const centreY = Math.round(centre[1])
  for (let dy = -r; dy <= r; dy += 1) {
    const y = centreY + dy
    if (y < 0 || y >= target.height) continue
    for (let dx = -r; dx <= r; dx += 1) {
      const x = centreX + dx
      if (x < 0 || x >= target.width) continue
      const pixel = (y * target.width + x) * 4
      const carried = ((dy + r) * side + dx + r) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        data[carried + channel] = target.data[pixel + channel]
      }
    }
  }
  return { data, side }
}

/**
 * One dab. `radius` is half the brush diameter, `hardness` and `strength` are 0…1.
 *
 * The carry's own side fixes the number of pixels a dab visits, so a caller that reuses a carry
 * across a stroke of changing radius still indexes the patch it actually has. Pixels off the image
 * are skipped: a dab near or past an edge lays down and picks up only what is on the canvas, which
 * is what keeps a stroke running off the side from smearing a wrapped copy back in.
 */
export function smudgeDab(
  target: Rgba,
  carry: SmudgeCarry,
  to: [number, number],
  radius: number,
  hardness: number,
  strength: number,
): void {
  if (!(radius > 0)) return
  const r = Math.max(0, (carry.side - 1) / 2)
  const side = carry.side
  const keep = clamp01(strength)
  const softness = clamp01(hardness)
  const invR = 1 / radius
  const centreX = Math.round(to[0])
  const centreY = Math.round(to[1])
  for (let dy = -r; dy <= r; dy += 1) {
    const y = centreY + dy
    if (y < 0 || y >= target.height) continue
    for (let dx = -r; dx <= r; dx += 1) {
      const x = centreX + dx
      if (x < 0 || x >= target.width) continue
      const reach = weight(Math.sqrt(dx * dx + dy * dy) * invR, softness)
      if (reach <= 0) continue
      const pixel = (y * target.width + x) * 4
      const carried = ((dy + r) * side + dx + r) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        const under = target.data[pixel + channel]
        // What was under the brush last time, laid down here at the smudge's strength. All of it at
        // full strength drags the pixels along; less of it mixes with what is already here, which
        // is what softens the trail behind a fast stroke.
        const painted = under + (carry.data[carried + channel] - under) * reach * keep
        target.data[pixel + channel] = Math.max(0, Math.min(255, Math.round(painted)))
        // The brush then carries what it just left, not what it first picked up. Holding on to the
        // original patch stamped it again at every dab, a trail of ghost copies of the first pixel.
        carry.data[carried + channel] = painted
      }
    }
  }
}
