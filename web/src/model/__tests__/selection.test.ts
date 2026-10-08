import { describe, expect, it } from 'vitest'

import {
  ellipseSelection,
  fullSelection,
  inverted,
  polygonSelection,
  rectSelection,
  selectionContains,
  selectionOutline,
  selectionPath,
} from '../selection'

/** A rectangle-ish "path" recorder, so the path builders can be checked without a canvas. */
class PathRecorder {
  readonly calls: string[] = []

  rect(x: number, y: number, width: number, height: number): void {
    this.calls.push(`rect(${x},${y},${width},${height})`)
  }

  moveTo(x: number, y: number): void {
    this.calls.push(`moveTo(${x},${y})`)
  }

  lineTo(x: number, y: number): void {
    this.calls.push(`lineTo(${x},${y})`)
  }

  closePath(): void {
    this.calls.push('close()')
  }

  ellipse(cx: number, cy: number, rx: number, ry: number): void {
    this.calls.push(`ellipse(${cx},${cy},${rx},${ry})`)
  }
}

describe('a rectangular selection', () => {
  it('is discarded when the drag was too small to mean anything', () => {
    expect(rectSelection(10, 10, 0.4, 100)).toBeNull()
    expect(rectSelection(10, 10, 100, 0.4)).toBeNull()
  })

  it('normalises a drag made right to left', () => {
    const selection = rectSelection(100, 80, -60, -40)!
    expect(selection.x).toBe(40)
    expect(selection.y).toBe(40)
    expect(selection.width).toBe(60)
    expect(selection.height).toBe(40)
  })

  it('contains a point inside it and not one outside', () => {
    const selection = rectSelection(10, 10, 100, 50)!
    expect(selectionContains(selection, 50, 30)).toBe(true)
    expect(selectionContains(selection, 5, 30)).toBe(false)
    expect(selectionContains(selection, 50, 70)).toBe(false)
  })
})

describe('an elliptical selection', () => {
  it('excludes the corners of its own bounding box', () => {
    const selection = ellipseSelection(0, 0, 100, 100)!
    expect(selectionContains(selection, 50, 50)).toBe(true)
    // The bounding box corner is outside the ellipse, which is the whole difference between the two.
    expect(selectionContains(selection, 2, 2)).toBe(false)
  })
})

describe('a polygon selection', () => {
  /** An L shape: the notch is what a bounding-box test would get wrong. */
  const L: [number, number][] = [
    [0, 0],
    [100, 0],
    [100, 40],
    [40, 40],
    [40, 100],
    [0, 100],
  ]

  it('needs at least three points', () => {
    expect(polygonSelection([[0, 0], [10, 10]])).toBeNull()
    expect(polygonSelection(L)).not.toBeNull()
  })

  it('drops points the pointer reported without moving', () => {
    const noisy: [number, number][] = [
      [0, 0],
      [0.1, 0.1],
      [100, 0],
      [100.2, 0.1],
      [100, 100],
      [0, 100],
    ]
    expect(polygonSelection(noisy)!.points).toHaveLength(4)
  })

  it('takes its bounds from the outline', () => {
    const selection = polygonSelection(L)!
    expect([selection.x, selection.y, selection.width, selection.height]).toEqual([0, 0, 100, 100])
  })

  it('excludes the notch, which a bounding box would not', () => {
    const selection = polygonSelection(L)!
    expect(selectionContains(selection, 20, 20)).toBe(true)
    expect(selectionContains(selection, 80, 20)).toBe(true)
    expect(selectionContains(selection, 20, 80)).toBe(true)
    // Inside the bounding box, outside the shape.
    expect(selectionContains(selection, 80, 80)).toBe(false)
  })

  it('draws the outline as a closed path', () => {
    const path = new PathRecorder()
    const rule = selectionPath(path as unknown as CanvasPath, polygonSelection(L)!, 200, 200)
    expect(rule).toBe('nonzero')
    expect(path.calls[0]).toBe('moveTo(0,0)')
    expect(path.calls.at(-1)).toBe('close()')
    expect(path.calls.filter((call) => call.startsWith('lineTo'))).toHaveLength(5)
  })

  it('emits an SVG outline for the marching ants', () => {
    const outline = selectionOutline(polygonSelection(L)!, 200, 200)
    expect(outline.startsWith('M0 0')).toBe(true)
    expect(outline.endsWith('Z')).toBe(true)
  })
})

describe('inverting', () => {
  it('flips what is inside', () => {
    const selection = rectSelection(10, 10, 20, 20)!
    const flipped = inverted(selection)
    expect(selectionContains(flipped, 15, 15)).toBe(false)
    expect(selectionContains(flipped, 100, 100)).toBe(true)
  })

  it('needs the canvas to clip an inverted shape, so the rule goes even-odd', () => {
    const path = new PathRecorder()
    const rule = selectionPath(path as unknown as CanvasPath, inverted(fullSelection(80, 40)), 80, 40)
    expect(rule).toBe('evenodd')
    // The canvas rectangle is wound first, then the shape the other way.
    expect(path.calls[1]).toBe('rect(0,0,80,40)')
  })

  it('leaves an uninverted shape on the plain rule', () => {
    const path = new PathRecorder()
    expect(selectionPath(path as unknown as CanvasPath, fullSelection(80, 40), 80, 40)).toBe('nonzero')
  })
})

describe('no selection at all', () => {
  it('contains every point, which is what makes painting unlimited', () => {
    expect(selectionContains(null, -9999, 12345)).toBe(true)
  })

  it('has no outline', () => {
    expect(selectionOutline(null, 100, 100)).toBe('')
  })
})
