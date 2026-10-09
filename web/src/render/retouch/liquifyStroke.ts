/**
 * A liquify session: the mesh, and the picture it is warping.
 *
 * Two things are kept for as long as the tool is on one layer, and both are needed for the same
 * reason:
 *
 * - **the mesh**, because a deformation accumulates. Every dab of every stroke since the session
 *   began is in it, which is what makes a slow drag push the same pixels further rather than
 *   re-pushing a fresh copy of them.
 * - **the picture from before the first dab**, because that is what the mesh is a warp *of*. Taking
 *   the layer's current pixels per stroke instead looks identical for the first push and is wrong
 *   for every one after it: the second stroke would warp the first stroke's output, which is how a
 *   liquify turns into a smear.
 *
 * Keeping both is also what gives Reconstruct something to mean. It pulls the mesh back towards
 * rest, and the picture comes back with it — a deform is taken back by un-deforming it, not by an
 * undo step, because the picture was never a stack of states. Leave the tool and the session goes:
 * the deformation is baked into the layer, which is what Photoshop's dialog closing does too.
 *
 * Nothing here is allocated until the first dab: choosing the tool costs nothing, and a click that
 * does not move is not a stroke.
 */

import { clampRect, unionRect, type DirtyRect, type LayerSurface } from '../paint'
import {
  applyDab,
  createMesh,
  dabBounds,
  meshIsClean,
  warp,
  type LiquifyMesh,
  type LiquifyMode,
} from './liquify'
import type { Rgba } from './types'

export interface LiquifyOptions {
  mode: LiquifyMode
  /** Half the tip's size, in layer pixels. */
  radius: number
  /** 0 a fully soft tip, 1 a hard one. */
  hardness: number
  /** 0–1, how much of a full dab each one is. */
  strength: number
}

/** How far apart dabs go along a drag, as a fraction of the tip's radius. */
const SPACING = 0.25

export class LiquifySession {
  private readonly surface: LayerSurface
  /** The layer as it was before this session's first dab, and the mesh over it. */
  private before: Rgba | null = null
  private mesh: LiquifyMesh | null = null
  private last: [number, number] | null = null
  private touched: DirtyRect | null = null
  private moved = false

  constructor(surface: LayerSurface) {
    this.surface = surface
  }

  /** What this stroke changed, for the caller's upload and undo bookkeeping. */
  get dirty(): DirtyRect | null {
    return this.touched
  }

  /** Whether any dab moved anything, so an empty stroke can be a no-op. */
  get changed(): boolean {
    return this.moved
  }

  /** Whether the picture is back where it started: the mesh is at rest again. */
  get isClean(): boolean {
    return this.mesh === null || meshIsClean(this.mesh)
  }

  /**
   * Drabs along a drag, in layer pixels.
   *
   * The first point of a stroke is a dab of its own (a click with Push does nothing, a click with
   * Pucker does something), and the rest are spaced along the segment the way the brush stamps.
   */
  to(point: [number, number], options: LiquifyOptions): void {
    const mesh = this.useMesh()
    const from = this.last
    this.last = point
    if (!from) {
      this.dab(mesh, point, point, options)
      return
    }
    const distance = Math.hypot(point[0] - from[0], point[1] - from[1])
    const step = Math.max(0.5, options.radius * SPACING)
    const steps = Math.max(1, Math.ceil(distance / step))
    let previous = from
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps
      const at: [number, number] = [
        from[0] + (point[0] - from[0]) * t,
        from[1] + (point[1] - from[1]) * t,
      ]
      this.dab(mesh, at, previous, options)
      previous = at
    }
  }

  /** The end of a stroke: the next one starts a fresh segment rather than a line from this point. */
  finish(): DirtyRect | null {
    this.last = null
    return this.touched
  }

  /** Forgets the session, for when the tool or the layer changes. */
  release(): void {
    this.before = null
    this.mesh = null
    this.last = null
    this.touched = null
    this.moved = false
  }

  /** The mesh, and the picture under it, made on the first dab that needs them. */
  private useMesh(): LiquifyMesh {
    if (this.mesh) return this.mesh
    const image = this.surface.context.getImageData(0, 0, this.surface.width, this.surface.height)
    this.before = {
      // Copied, not held: the canvas's own array is the live one, and the whole point of this is
      // that it stops changing.
      data: new Uint8ClampedArray(image.data),
      width: this.surface.width,
      height: this.surface.height,
    }
    this.mesh = createMesh(this.surface.width, this.surface.height)
    return this.mesh
  }

  /** One dab: move the mesh, then re-warp the box the dab can have reached. */
  private dab(
    mesh: LiquifyMesh,
    point: [number, number],
    from: [number, number],
    options: LiquifyOptions,
  ): void {
    const before = this.before
    if (!before) return
    const radius = Math.max(0.5, options.radius)
    applyDab(mesh, {
      mode: options.mode,
      x: point[0],
      y: point[1],
      from,
      radius,
      hardness: options.hardness,
      strength: options.strength,
    })
    if (meshIsClean(mesh)) {
      // Nothing has moved yet, which is a click with Push — nothing to draw. Or the mesh has just
      // been reconstructed all the way back, and then the pixels it had moved have to be put back:
      // the whole picture, because no dab-sized box can say where they were taken from.
      if (!this.moved) return
      const whole = { x: 0, y: 0, width: before.width, height: before.height }
      this.blit(warp(before, mesh, whole), whole)
      return
    }
    this.moved = true
    const box = clampRect(
      dabBounds({
        mode: options.mode,
        x: point[0],
        y: point[1],
        radius,
        hardness: options.hardness,
        strength: options.strength,
      }),
      before.width,
      before.height,
    )
    // A dab that reached only past the layer's edge has nothing to draw.
    if (!box) return
    this.blit(warp(before, mesh, box), box)
  }

  private blit(warped: Rgba, box: DirtyRect): void {
    // No copy here, unlike the retouch samples: `warp` allocated this buffer itself and nothing
    // else holds it, so handing it to the canvas is handing over something already private. The
    // cast is only because `ImageData` insists on an array backed by a plain `ArrayBuffer`.
    const image = new ImageData(warped.data as ImageDataArray, warped.width, warped.height)
    this.surface.context.putImageData(image, box.x, box.y)
    this.touched = unionRect(this.touched, box)
  }
}