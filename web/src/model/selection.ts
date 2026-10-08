/**
 * The selection.
 *
 * One shape at a time, optionally inverted — which is enough for the marquee tools and for
 * "Select All", "Deselect" and "Inverse" without a full 8-bit selection mask. Photoshop keeps a
 * mask; when feathering and the lasso arrive, this type grows into one.
 */

export type SelectionKind = 'rectangle' | 'ellipse'

export interface Selection {
  kind: SelectionKind
  /** Document-space bounds. */
  x: number
  y: number
  width: number
  height: number
  /** True when everything *outside* the shape is selected. */
  inverted: boolean
}

export function rectSelection(
  x: number,
  y: number,
  width: number,
  height: number,
): Selection | null {
  const left = Math.min(x, x + width)
  const top = Math.min(y, y + height)
  const w = Math.abs(width)
  const h = Math.abs(height)
  // A stray click is not a selection; Photoshop discards drags under a few pixels too.
  if (w < 1 || h < 1) return null
  return { kind: 'rectangle', x: left, y: top, width: w, height: h, inverted: false }
}

export function ellipseSelection(
  x: number,
  y: number,
  width: number,
  height: number,
): Selection | null {
  const rect = rectSelection(x, y, width, height)
  return rect ? { ...rect, kind: 'ellipse' } : null
}

export function fullSelection(canvasWidth: number, canvasHeight: number): Selection {
  return { kind: 'rectangle', x: 0, y: 0, width: canvasWidth, height: canvasHeight, inverted: false }
}

export function inverted(selection: Selection): Selection {
  return { ...selection, inverted: !selection.inverted }
}

/** Whether a document point is selected — used to clip painting and to report the pointer state. */
export function selectionContains(selection: Selection | null, x: number, y: number): boolean {
  if (!selection) return true
  const inside = shapeContains(selection, x, y)
  return selection.inverted ? !inside : inside
}

function shapeContains(selection: Selection, x: number, y: number): boolean {
  if (
    x < selection.x ||
    y < selection.y ||
    x > selection.x + selection.width ||
    y > selection.y + selection.height
  ) {
    return false
  }
  if (selection.kind === 'rectangle') return true
  const rx = selection.width / 2
  const ry = selection.height / 2
  const dx = (x - (selection.x + rx)) / Math.max(rx, 1e-6)
  const dy = (y - (selection.y + ry)) / Math.max(ry, 1e-6)
  return dx * dx + dy * dy <= 1
}

/** Draws the shape into the current path, without beginning or clipping it. */
function addShape(path: CanvasPath, selection: Selection): void {
  if (selection.kind === 'rectangle') {
    path.rect(selection.x, selection.y, selection.width, selection.height)
  } else {
    path.ellipse(
      selection.x + selection.width / 2,
      selection.y + selection.height / 2,
      Math.max(selection.width / 2, 1e-6),
      Math.max(selection.height / 2, 1e-6),
      0,
      0,
      Math.PI * 2,
    )
  }
}

/**
 * Builds the selection as one path, and says which fill rule makes it mean what it says.
 *
 * An inverted selection is the canvas minus the shape, which the even-odd rule expresses without
 * any boolean geometry: the canvas rectangle wound one way, the shape the other.
 */
export function selectionPath(
  path: CanvasPath,
  selection: Selection,
  canvasWidth: number,
  canvasHeight: number,
): CanvasFillRule {
  if (!selection.inverted) {
    addShape(path, selection)
    return 'nonzero'
  }
  path.rect(0, 0, canvasWidth, canvasHeight)
  addShape(path, selection)
  return 'evenodd'
}

/**
 * Clips a drawing context to the selection.
 *
 * The context's own transform is used, so callers working in a different space than the selection
 * — a layer's pixels rather than the document's — can `setTransform` first and clip in document
 * coordinates. A clip is recorded in device space, so a later transform change does not move it.
 */
export function clipToSelection(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  selection: Selection | null,
  canvasWidth: number,
  canvasHeight: number,
): void {
  if (!selection) return
  context.beginPath()
  context.clip(selectionPath(context, selection, canvasWidth, canvasHeight))
}

/** An SVG path for the marching-ants overlay, in document coordinates. */
export function selectionOutline(selection: Selection | null, canvasWidth: number, canvasHeight: number): string {
  if (!selection) return ''
  const shapes: string[] = []
  if (selection.inverted) shapes.push(`M0 0H${canvasWidth}V${canvasHeight}H0Z`)
  if (selection.kind === 'rectangle') {
    const { x, y, width, height } = selection
    shapes.push(`M${x} ${y}H${x + width}V${y + height}H${x}Z`)
  } else {
    const rx = selection.width / 2
    const ry = selection.height / 2
    const cx = selection.x + rx
    const cy = selection.y + ry
    shapes.push(`M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`)
  }
  return shapes.join(' ')
}
