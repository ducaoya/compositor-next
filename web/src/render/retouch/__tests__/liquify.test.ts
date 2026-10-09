import { describe, expect, it } from 'vitest'

import {
  applyDab,
  createMesh,
  dabBounds,
  falloff,
  meshIsClean,
  resetMesh,
  sampleMesh,
  warp,
  type LiquifyDab,
  type LiquifyMesh,
} from '../liquify'
import type { Rgba } from '../types'

function blank(width: number, height: number): Rgba {
  return { data: new Uint8ClampedArray(width * height * 4), width, height }
}

/** A white block on transparent black, so where the content is can be measured. */
function withBlock(width: number, height: number, from: number, to: number): Rgba {
  const pixels = blank(width, height)
  for (let y = 0; y < height; y += 1) {
    for (let x = from; x < to; x += 1) {
      const at = (y * width + x) * 4
      pixels.data[at] = 255
      pixels.data[at + 1] = 255
      pixels.data[at + 2] = 255
      pixels.data[at + 3] = 255
    }
  }
  return pixels
}

/** The mean x of the lit pixels, which is where the content ended up. */
function centroidX(pixels: Rgba, channel = 0): number {
  let total = 0
  let weight = 0
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      const value = pixels.data[(y * pixels.width + x) * 4 + channel]
      total += x * value
      weight += value
    }
  }
  return weight === 0 ? 0 : total / weight
}

function dab(patch: Partial<LiquifyDab> = {}): LiquifyDab {
  return { mode: 'push', x: 32, y: 32, radius: 16, hardness: 0, strength: 1, ...patch }
}

/** The displacement of the control point nearest a coordinate. */
function at(mesh: LiquifyMesh, x: number, y: number): [number, number] {
  const col = Math.round(x / mesh.spacing)
  const row = Math.round(y / mesh.spacing)
  const point = row * (mesh.cols + 1) + col
  return [mesh.dx[point], mesh.dy[point]]
}

describe('the mesh', () => {
  it('covers the layer at its own spacing and starts at rest', () => {
    const mesh = createMesh(100, 40, 16)
    expect(mesh.cols).toBe(7)
    expect(mesh.rows).toBe(3)
    expect(mesh.dx.length).toBe((7 + 1) * (3 + 1))
    expect(meshIsClean(mesh)).toBe(true)
  })

  it('interpolates between control points, and clamps at the edges', () => {
    const mesh = createMesh(64, 64, 16)
    mesh.dx[1 * (mesh.cols + 1) + 1] = 8 // the point at (16, 16)
    expect(sampleMesh(mesh, 16, 16)).toEqual([8, 0])
    // Halfway to the next point along, half the displacement.
    expect(sampleMesh(mesh, 24, 16)[0]).toBeCloseTo(4, 6)
    expect(sampleMesh(mesh, 8, 16)[0]).toBeCloseTo(4, 6)
    // Beyond the last control point the mesh holds rather than wraps.
    expect(sampleMesh(mesh, 64, 16)[0]).toBe(0)
  })

  it('can be put back to rest', () => {
    const mesh = createMesh(64, 64)
    applyDab(mesh, dab({ from: [22, 32] }))
    expect(meshIsClean(mesh)).toBe(false)
    resetMesh(mesh)
    expect(meshIsClean(mesh)).toBe(true)
  })
})

describe('the falloff', () => {
  it('is full in the middle, nothing past the rim, and smooth at both', () => {
    expect(falloff(0, 10, 0)).toBe(1)
    expect(falloff(10, 10, 0)).toBe(0)
    expect(falloff(20, 10, 0)).toBe(0)
    // A bump, not a cone: it has to arrive at the rim with no slope, or every dab leaves a crease.
    expect(falloff(9.9, 10, 0)).toBeLessThan(0.01)
    expect(falloff(5, 10, 0)).toBeCloseTo(0.5625, 6)
  })

  it('leaves the hard part of the tip at full strength', () => {
    expect(falloff(4, 10, 0.5)).toBe(1)
    expect(falloff(5, 10, 0.5)).toBe(1)
    expect(falloff(7.5, 10, 0.5)).toBeGreaterThan(0)
    expect(falloff(7.5, 10, 0.5)).toBeLessThan(1)
  })
})

describe('a push', () => {
  it('drags the middle the way the pointer went and leaves the rim alone', () => {
    const mesh = createMesh(64, 64)
    applyDab(mesh, dab({ x: 32, y: 32, from: [32 - 10, 32], radius: 32 }))
    const [dx] = at(mesh, 32, 32)
    // The mesh is a backward map: content moves right, so a pixel reads from the left.
    expect(dx).toBeCloseTo(-10, 6)
    const [edge] = at(mesh, 64, 32)
    expect(edge).toBeCloseTo(0, 6)
  })

  it('bends with the distance, so the edge moves less than the centre', () => {
    const mesh = createMesh(96, 96)
    applyDab(mesh, dab({ x: 48, y: 48, from: [38, 48], radius: 32 }))
    const near = Math.abs(at(mesh, 48, 48)[0])
    const far = Math.abs(at(mesh, 64, 48)[0])
    const further = Math.abs(at(mesh, 80, 48)[0])
    expect(near).toBeCloseTo(10, 6)
    expect(far).toBeGreaterThan(0)
    expect(far).toBeLessThan(near)
    expect(further).toBeLessThan(far)
  })

  it('pushes nothing at all when there is nowhere to push from', () => {
    const mesh = createMesh(64, 64)
    applyDab(mesh, dab())
    expect(meshIsClean(mesh)).toBe(true)
  })
})

describe('the other modes', () => {
  it('turns the picture clockwise on a clockwise twirl, and the other way on a counter one', () => {
    const clockwise = createMesh(96, 96)
    applyDab(clockwise, dab({ mode: 'twirlClockwise', x: 48, y: 48, radius: 32 }))
    // On screen +y is down, so a clockwise turn takes the point to the right of the centre down.
    expect(at(clockwise, 64, 48)[1]).toBeGreaterThan(0)

    const counter = createMesh(96, 96)
    applyDab(counter, dab({ mode: 'twirlCounter', x: 48, y: 48, radius: 32 }))
    expect(at(counter, 64, 48)[1]).toBeLessThan(0)
    // A turn moves a point around its centre, not in or out: the distance to the middle holds.
    const [dx, dy] = at(counter, 64, 48)
    expect(Math.hypot(16 + dx, dy)).toBeCloseTo(16, 4)
  })

  it('pulls towards the centre and pushes away from it', () => {
    const pucker = createMesh(96, 96)
    applyDab(pucker, dab({ mode: 'pucker', x: 48, y: 48, radius: 32 }))
    // The point at (64, 48) is 16 to the right; a pucker moves it left, towards the centre.
    expect(at(pucker, 64, 48)[0]).toBeLessThan(0)

    const bloat = createMesh(96, 96)
    applyDab(bloat, dab({ mode: 'bloat', x: 48, y: 48, radius: 32 }))
    expect(at(bloat, 64, 48)[0]).toBeGreaterThan(0)
  })

  it('pulls a displacement back towards rest, and keeps pulling on the next dab', () => {
    const mesh = createMesh(96, 96)
    applyDab(mesh, dab({ x: 48, y: 48, from: [28, 48], radius: 32 }))
    const pushed = at(mesh, 48, 48)[0]
    expect(pushed).toBeCloseTo(-20, 6)
    let before = pushed
    for (let dabIndex = 0; dabIndex < 6; dabIndex += 1) {
      applyDab(mesh, dab({ mode: 'reconstruct', x: 48, y: 48, radius: 32 }))
      const now = at(mesh, 48, 48)[0]
      // Each dab takes back a share of what is left, so the displacement shrinks every time and
      // reaches nothing rather than stalling short of it.
      expect(Math.abs(now)).toBeLessThanOrEqual(Math.abs(before))
      before = now
    }
    expect(Math.abs(before)).toBeLessThan(0.5)
  })
})

describe('the warp', () => {
  it('is the identity where the mesh has not been touched', () => {
    const source = withBlock(32, 32, 8, 16)
    const warped = warp(source, createMesh(32, 32), { x: 0, y: 0, width: 32, height: 32 })
    expect(warped.data).toEqual(source.data)
  })

  it('moves the content the way the mesh says, and only inside the rectangle it was asked for', () => {
    const source = withBlock(64, 32, 24, 40)
    const mesh = createMesh(64, 32)
    // Content to the right: every pixel reads from ten to the left of itself.
    for (let point = 0; point < mesh.dx.length; point += 1) mesh.dx[point] = -10
    const bounds = { x: 8, y: 0, width: 48, height: 32 }
    const warped = warp(source, mesh, bounds)
    expect(warped.width).toBe(48)
    expect(Math.round(centroidX(warped) + bounds.x)).toBe(Math.round(centroidX(source) + 10))
  })

  it('clamps at the edge rather than reading around the back of the image', () => {
    const source = blank(16, 8)
    // A red first column and a blue last one: a wrap would put red where blue is.
    for (let y = 0; y < 8; y += 1) {
      source.data[(y * 16) * 4] = 255
      source.data[(y * 16) * 4 + 3] = 255
      source.data[(y * 16 + 15) * 4 + 2] = 255
      source.data[(y * 16 + 15) * 4 + 3] = 255
    }
    const mesh = createMesh(16, 8)
    // Every pixel reads five to its right, so the last five columns are past the edge.
    for (let point = 0; point < mesh.dx.length; point += 1) mesh.dx[point] = 5
    const warped = warp(source, mesh, { x: 0, y: 0, width: 16, height: 8 })
    // Held at the edge: the last columns stay blue rather than wrapping round to red.
    expect(warped.data[15 * 4 + 2]).toBe(255)
    expect(warped.data[11 * 4 + 2]).toBe(255)
    expect(warped.data[11 * 4]).toBe(0)
  })

  it('bounds a dab by its radius, not by the layer', () => {
    const bounds = dabBounds(dab({ x: 100, y: 50, radius: 10 }))
    expect(bounds.x).toBe(80)
    expect(bounds.y).toBe(30)
    expect(bounds.width).toBe(40)
    expect(bounds.height).toBe(40)
  })
})
