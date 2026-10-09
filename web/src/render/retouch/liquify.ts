/**
 * Liquify: moving pixels about without touching their colour.
 *
 * The tool is a *mesh*, not a per-pixel displacement map, and that is the decision everything else
 * follows from. Photoshop's Liquify is a coarse grid of control points whose displacement is
 * interpolated; a per-pixel field for a 4,000 × 4,000 layer would be 128 MB of floats and would
 * change as fast as a brush moves. A 16-pixel grid is a few hundred kilobytes, it is smooth by
 * construction, and it is what makes a stroke cheap to keep applying: a dab moves a handful of
 * control points, and the pixels are sampled through the mesh.
 *
 * The mesh holds a **backward** map: the displacement at a point is where the pixel *reads from*,
 * relative to itself. That is the direction a resampler needs — a destination pixel asks where its
 * colour is coming from — and it is why a drag that moves the pointer from A to B subtracts its
 * own offset. Storing the forward direction instead would mean inverting the map per pixel, which
 * is a search rather than a lookup, for a picture that looks the same.
 * The falloff is a bump that reaches zero *smoothly* at the rim — `(1 - u²)²`, Photoshop's own
 * shape. For a colour that would not matter much; for a displacement it does, because a falloff
 * that stops with a slope leaves a crease in the picture at the edge of every dab.
 */

import type { Bounds, Rgba } from './types'

/** How far apart the mesh's control points are, in layer pixels. */
export const MESH_SPACING = 16

export interface LiquifyMesh {
  /** Control points across and down, so the mesh holds `(cols + 1) × (rows + 1)` points. */
  cols: number
  rows: number
  spacing: number
  /** The layer's size, which is what the mesh has to cover. */
  width: number
  height: number
  /** Where each control point reads from, relative to its own rest position, in layer pixels. */
  dx: Float32Array
  dy: Float32Array
}

/** Which liquify the pointer is doing. */
export type LiquifyMode = 'push' | 'twirlClockwise' | 'twirlCounter' | 'pucker' | 'bloat' | 'reconstruct'

export interface LiquifyDab {
  mode: LiquifyMode
  /** Where the pointer is, in layer pixels. */
  x: number
  y: number
  /** Push: where the pointer was, which is the direction the pixels are dragged. */
  from?: [number, number]
  /** Half the brush's size, in layer pixels. */
  radius: number
  /** The brush's edge: 0 a fully soft dab, 1 a hard one. */
  hardness: number
  /** 0–1, how much of a full dab this one is. */
  strength: number
}

/** A mesh at rest, covering the whole layer. */
export function createMesh(width: number, height: number, spacing = MESH_SPACING): LiquifyMesh {
  const cols = Math.max(1, Math.ceil(width / spacing))
  const rows = Math.max(1, Math.ceil(height / spacing))
  const points = (cols + 1) * (rows + 1)
  return {
    cols,
    rows,
    spacing,
    width,
    height,
    dx: new Float32Array(points),
    dy: new Float32Array(points),
  }
}

/** Whether anything has been moved, so an empty stroke can be a no-op. */
export function meshIsClean(mesh: LiquifyMesh): boolean {
  for (let point = 0; point < mesh.dx.length; point += 1) {
    if (mesh.dx[point] !== 0 || mesh.dy[point] !== 0) return false
  }
  return true
}

/** Puts every control point back where it started. */
export function resetMesh(mesh: LiquifyMesh): void {
  mesh.dx.fill(0)
  mesh.dy.fill(0)
}

/**
 * How much of a dab reaches a control point `distance` from its centre.
 *
 * Zero at the rim *and* with a zero slope, so neighbouring dabs join without a seam and the edge of
 * a dab is not a visible ridge. `hardness` is the fraction of the radius that is left at full
 * strength, which is what the options bar's Hardness means for every other brush here.
 */
export function falloff(distance: number, radius: number, hardness: number): number {
  if (radius <= 0) return 0
  const u = distance / radius
  if (u >= 1) return 0
  const inner = Math.min(Math.max(hardness, 0), 0.999)
  if (u <= inner) return 1
  // The bump is `(1 - t²)²` on how far along the soft part of the tip the point is, which is 1 in
  // the middle, 0 at the rim, and arrives flat at both ends.
  const t = (u - inner) / (1 - inner)
  const bump = 1 - t * t
  return bump * bump
}

/** The rectangle a dab can have moved pixels in, which is what the caller has to re-upload. */
export function dabBounds(dab: LiquifyDab): Bounds {
  const radius = Math.max(0.5, dab.radius)
  // A dab moves pixels by at most its own radius: a push drags by one dab's worth of the drag,
  // which the caller keeps to a fraction of the tip, and a twirl turns a point about the centre
  // without moving it further out. Twice the radius either way is slack, not a guess.
  const reach = radius * 2
  return {
    x: Math.floor(dab.x - reach),
    y: Math.floor(dab.y - reach),
    width: Math.ceil(reach * 2),
    height: Math.ceil(reach * 2),
  }
}

/**
 * Moves the mesh's control points for one dab.
 *
 * Each mode is a different arithmetic on the offset between a control point and the dab's centre,
 * which is why they share a loop rather than a function each.
 */
export function applyDab(mesh: LiquifyMesh, dab: LiquifyDab): void {
  const radius = Math.max(0.5, dab.radius)
  const strength = Math.min(1, Math.max(0, dab.strength))
  if (strength === 0) return
  const spacing = mesh.spacing
  const firstCol = Math.max(0, Math.floor((dab.x - radius) / spacing))
  const lastCol = Math.min(mesh.cols, Math.ceil((dab.x + radius) / spacing))
  const firstRow = Math.max(0, Math.floor((dab.y - radius) / spacing))
  const lastRow = Math.min(mesh.rows, Math.ceil((dab.y + radius) / spacing))

  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let col = firstCol; col <= lastCol; col += 1) {
      const point = row * (mesh.cols + 1) + col
      // A control point's rest position, and where it currently is: a dab works on where the mesh
      // *is*, which is what lets one stroke push the same pixels twice — and reconstruct works on
      // the rest position, because what it is undoing is the displacement of the picture under the
      // brush.
      const restX = col * spacing
      const restY = row * spacing
      const px = restX + mesh.dx[point]
      const py = restY + mesh.dy[point]
      const offsetX =
        dab.mode === 'reconstruct' ? restX - dab.x : px - dab.x
      const offsetY =
        dab.mode === 'reconstruct' ? restY - dab.y : py - dab.y
      const distance = Math.hypot(offsetX, offsetY)
      const weight = falloff(distance, radius, dab.hardness) * strength
      if (weight === 0) continue

      switch (dab.mode) {
        case 'push': {
          // The drag, backwards: a pixel at the pointer's new place reads from where the pointer
          // was. A dab with no `from` is a click, which pushes nothing.
          const [fromX, fromY] = dab.from ?? [dab.x, dab.y]
          mesh.dx[point] -= (dab.x - fromX) * weight
          mesh.dy[point] -= (dab.y - fromY) * weight
          break
        }
        case 'twirlClockwise':
        case 'twirlCounter': {
          // Turn the point's offset about the centre: the pixels swirl without moving in or out.
          const turn = (dab.mode === 'twirlClockwise' ? 1 : -1) * weight * 0.35
          const cos = Math.cos(turn)
          const sin = Math.sin(turn)
          const turnedX = offsetX * cos - offsetY * sin
          const turnedY = offsetX * sin + offsetY * cos
          mesh.dx[point] += turnedX - offsetX
          mesh.dy[point] += turnedY - offsetY
          break
        }
        case 'pucker':
        case 'bloat': {
          // Scale the offset: towards the centre for a pucker, away from it for a bloat. A fifth at
          // full strength is Photoshop's kind of rate — enough to see in one dab, and slow enough
          // that a dab a pixel apart does not tear the picture.
          const scale = 1 + (dab.mode === 'bloat' ? 1 : -1) * weight * 0.2
          mesh.dx[point] += offsetX * (scale - 1)
          mesh.dy[point] += offsetY * (scale - 1)
          break
        }
        case 'reconstruct': {
          // Pull back towards rest, in proportion to how far from rest it is.
          mesh.dx[point] -= mesh.dx[point] * weight
          mesh.dy[point] -= mesh.dy[point] * weight
          break
        }
      }
    }
  }
}

/** The mesh's displacement at a point, bilinearly between its four nearest control points. */
export function sampleMesh(
  mesh: LiquifyMesh,
  x: number,
  y: number,
): [number, number] {
  const across = x / mesh.spacing
  const down = y / mesh.spacing
  const col = Math.min(mesh.cols - 1, Math.max(0, Math.floor(across)))
  const row = Math.min(mesh.rows - 1, Math.max(0, Math.floor(down)))
  const fu = Math.min(1, Math.max(0, across - col))
  const fv = Math.min(1, Math.max(0, down - row))
  const stride = mesh.cols + 1
  const at = (c: number, r: number) => r * stride + c

  const one = at(col, row)
  const two = at(col + 1, row)
  const three = at(col, row + 1)
  const four = at(col + 1, row + 1)
  const topX = mesh.dx[one] + (mesh.dx[two] - mesh.dx[one]) * fu
  const bottomX = mesh.dx[three] + (mesh.dx[four] - mesh.dx[three]) * fu
  const topY = mesh.dy[one] + (mesh.dy[two] - mesh.dy[one]) * fu
  const bottomY = mesh.dy[three] + (mesh.dy[four] - mesh.dy[three]) * fu
  return [topX + (bottomX - topX) * fv, topY + (bottomY - topY) * fv]
}

/** The byte at a coordinate, or the edge's byte when the coordinate is outside the buffer. */
function sampleChannel(pixels: Rgba, x: number, y: number, channel: number): number {
  const clampedX = x < 0 ? 0 : x >= pixels.width ? pixels.width - 1 : x
  const clampedY = y < 0 ? 0 : y >= pixels.height ? pixels.height - 1 : y
  return pixels.data[(clampedY * pixels.width + clampedX) * 4 + channel]
}

/**
 * Reads the source at a fractional coordinate, bilinearly.
 *
 * Straight alpha throughout: these buffers are what a canvas stores, where a half-transparent pixel
 * holds its colour un-multiplied, and mixing the two conventions is how an edge picks up a dark
 * halo.
 */
function sampleBilinear(pixels: Rgba, x: number, y: number, out: Uint8ClampedArray, at: number): void {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  for (let channel = 0; channel < 4; channel += 1) {
    const top = sampleChannel(pixels, x0, y0, channel) * (1 - fx) + sampleChannel(pixels, x0 + 1, y0, channel) * fx
    const bottom =
      sampleChannel(pixels, x0, y0 + 1, channel) * (1 - fx) + sampleChannel(pixels, x0 + 1, y0 + 1, channel) * fx
    out[at + channel] = top * (1 - fy) + bottom * fy
  }
}

/**
 * Warps a rectangle of `source` through the mesh.
 *
 * Only the rectangle asked for is computed and returned, which is what lets a stroke re-warp the
 * brush's own box rather than the layer: the pixels outside it are still the pixels that were
 * there, because a dab's reach is bounded by its radius.
 */
export function warp(source: Rgba, mesh: LiquifyMesh, bounds: Bounds): Rgba {
  const width = Math.max(0, Math.min(bounds.width, source.width - bounds.x))
  const height = Math.max(0, Math.min(bounds.height, source.height - bounds.y))
  const data = new Uint8ClampedArray(width * height * 4)
  const out: Rgba = { data, width, height }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [dx, dy] = sampleMesh(mesh, bounds.x + x, bounds.y + y)
      // The mesh says where the pixel *reads from*, so it is added: a displacement of `-10` at a
      // pixel means its colour comes from ten to the left, which is a picture that has moved right.
      sampleBilinear(source, bounds.x + x + dx, bounds.y + y + dy, data, (y * width + x) * 4)
    }
  }
  return out
}
