<script setup lang="ts">
/**
 * The document window: the canvas, its tab, and every pointer behaviour.
 *
 * One state machine handles the drag that is in progress, because a press has to be interpreted
 * once, at the moment the button goes down — deciding per-move-event what a drag "is" is how a
 * marquee turns into a move halfway through.
 *
 * Rendering is scheduled rather than continuous: a change to the document, the view or the paint
 * surfaces marks the frame dirty, and one animation frame later the compositor draws it.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { containsPoint } from '../model/document'
import { polygonSelection, selectionOutline } from '../model/selection'
import { isFolder, visibleLeaves, type Transform } from '../model/types'
import {
  attachCanvas,
  beginEdit,
  magicWandAt,
  beginStroke,
  detachCanvas,
  draws,
  endEdit,
  endStroke,
  extendStroke,
  fit,
  applyCrop,
  applySelectionMode,
  drawGradient,
  drawShape,
  flushPaint,
  importDroppedFiles,
  layerMatrix,
  layerPixelSize,
  marqueeSelection,
  panBy,
  setCropRect,
  pickColor,
  registerDropTarget,
  selectLayer,
  setSelection,
  snapMove,
  toDocument,
  useSession,
  zoomAt,
} from '../state/session'

const { t } = useI18n()
const {
  manifest,
  canRender,
  canGPU,
  message,
  view,
  viewport,
  activeLayerId,
  selectedIds,
  tool,
  brush,
  selection,
  cropRect,

  shape,
  wandTolerance,
  wandContiguous,
} = useSession()

const host = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const pointer = ref<[number, number] | null>(null)
const dragGuides = ref<{ x: number[]; y: number[] }>({ x: [], y: [] })
const dropActive = ref(false)
/** The line a gradient or shape tool is dragging, for the preview it draws. */
const previewDrag = ref<{ kind: string; from: [number, number]; to: [number, number] } | null>(null)
const trace = { mounts: 0, schedules: 0, renders: 0, skipped: [] as string[], errors: [] as string[] }
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__stageTrace', { value: trace, configurable: true })
}

let frame = 0
let needsRender = true
let observer: ResizeObserver | null = null
let spaceHeld = false

type Drag =
  | { kind: 'none' }
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'marquee'; start: [number, number]; current: [number, number]; elliptical: boolean }
  | { kind: 'lasso'; points: [number, number][] }
  | { kind: 'crop'; start: [number, number]; current: [number, number] }
  | { kind: 'gradient'; start: [number, number]; current: [number, number] }
  | { kind: 'shape'; start: [number, number]; current: [number, number] }
  | { kind: 'paint' }
  | { kind: 'move'; layerId: string; startOrigin: [number, number]; startPointer: [number, number] }
  | {
      kind: 'transform'
      layerId: string
      handle: string
      start: Transform
      anchor: [number, number]
      startAngle: number
    }
  | { kind: 'zoom'; out: boolean }

let drag: Drag = { kind: 'none' }

// MARK: - Rendering

function schedule(): void {
  trace.schedules += 1
  needsRender = true
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    if (!needsRender) return
    needsRender = false
    try {
      const target = useSession().compositor.value
      const element = canvas.value
      if (!target || !element) {
        trace.skipped.push(!target ? 'no compositor' : 'no canvas')
        return
      }
      const dpr = window.devicePixelRatio || 1
      target.resize(element.clientWidth * dpr, element.clientHeight * dpr)
      viewport.dpr = dpr
      // Whatever the brush touched since the last frame goes up before it is drawn.
      flushPaint()
      trace.renders += 1
      target.render(draws.value, {
        // The shader works in device pixels, so the view is scaled up by the pixel ratio.
        zoom: view.zoom * dpr,
        panX: view.panX * dpr,
        panY: view.panY * dpr,
      })
    } catch (error) {
      trace.errors.push(error instanceof Error ? error.message : String(error))
    }
  })
}

const documentRect = computed(() => {
  const current = manifest.value
  if (!current) return null
  return {
    left: view.panX,
    top: view.panY,
    width: current.width * view.zoom,
    height: current.height * view.zoom,
  }
})

const guideLines = computed(() => {
  const current = manifest.value
  const rect = documentRect.value
  if (!current || !rect) return []
  const stored = (current.guides ?? []).map((guide) => ({
    id: guide.id,
    vertical: guide.axis === 'vertical',
    offset:
      guide.axis === 'vertical' ? rect.left + guide.position * view.zoom : rect.top + guide.position * view.zoom,
  }))
  const live = [
    ...dragGuides.value.x.map((x, index) => ({
      id: `snap-x-${index}-${x}`,
      vertical: true,
      offset: rect.left + x * view.zoom,
    })),
    ...dragGuides.value.y.map((y, index) => ({
      id: `snap-y-${index}-${y}`,
      vertical: false,
      offset: rect.top + y * view.zoom,
    })),
  ]
  return [...stored, ...live]
})

/**
 * The eight scale handles, in document coordinates.
 *
 * They are the layer's own rectangle put through its matrix, so a rotated layer gets handles on its
 * rotated corners — which is what makes a transform feel attached to the layer rather than to the
 * document.
 */
const HANDLE_ORDER = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'rotate'] as const

const transformHandles = computed(() => {
  const layer = manifest.value?.layers.find((record) => record.id === activeLayerId.value)
  if (!layer || tool.value !== 'move') return []
  const { width, height } = layerPixelSize(layer)
  const matrix = layerMatrix(layer)
  const places: Record<string, [number, number]> = {
    nw: [0, 0],
    n: [0.5, 0],
    ne: [1, 0],
    e: [1, 0.5],
    se: [1, 1],
    s: [0.5, 1],
    sw: [0, 1],
    w: [0, 0.5],
  }
  const points = HANDLE_ORDER.map((id) => {
    if (id === 'rotate') {
      // The rotate handle floats above the top edge, where Photoshop's does.
      const above = matrix.transformPoint(new DOMPoint(width / 2, -24 / Math.max(view.zoom, 1e-6)))
      return { id, x: above.x, y: above.y }
    }
    const [u, v] = places[id]
    const point = matrix.transformPoint(new DOMPoint(u * width, v * height))
    return { id, x: point.x, y: point.y }
  })
  return points
})

/** The handle under a document point, within a screen-space tolerance. */
function handleAt(x: number, y: number): string | null {
  const tolerance = 7 / Math.max(view.zoom, 1e-6)
  for (const handle of transformHandles.value) {
    if (Math.hypot(handle.x - x, handle.y - y) <= tolerance) return handle.id
  }
  return null
}

/** The corner a scale drag pulls against: the one that stays put. */
function oppositeCorner(handle: string, transform: Transform): [number, number] {
  const [ox, oy] = transform.origin
  const [w, h] = transform.size
  const radians = (transform.rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const cx = ox + w / 2
  const cy = oy + h / 2
  const unit: Record<string, [number, number]> = {
    nw: [1, 1],
    ne: [0, 1],
    se: [0, 0],
    sw: [1, 0],
    n: [0.5, 1],
    s: [0.5, 0],
    e: [0, 0.5],
    w: [1, 0.5],
  }
  const [u, v] = unit[handle] ?? [0.5, 0.5]
  const lx = (u - 0.5) * w
  const ly = (v - 0.5) * h
  return [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos]
}

/** The active layer's box, for the Move tool's transform frame. */
const transformBox = computed(() => {
  const layer = manifest.value?.layers.find((record) => record.id === activeLayerId.value)
  if (!layer || tool.value !== 'move') return null
  const { width, height } = layerPixelSize(layer)
  const matrix = layerMatrix(layer)
  const corners: [number, number][] = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ].map(([x, y]) => {
    const point = matrix.transformPoint(new DOMPoint(x, y))
    return [point.x * view.zoom + view.panX, point.y * view.zoom + view.panY]
  })
  return corners.map((corner) => corner.join(',')).join(' ')
})

const brushCursor = computed(() => {
  if (tool.value !== 'brush' && tool.value !== 'eraser') return null
  const point = pointer.value
  if (!point) return null
  const diameter = Math.max(4, brush.size * view.zoom)
  return { left: point[0], top: point[1], size: diameter }
})

// MARK: - Pointer

function localPoint(event: PointerEvent | WheelEvent | DragEvent): [number, number] {
  const element = host.value
  if (!element) return [0, 0]
  const bounds = element.getBoundingClientRect()
  return [event.clientX - bounds.left, event.clientY - bounds.top]
}

function topmostLayerAt(x: number, y: number): string | null {
  const current = manifest.value
  if (!current) return null
  const leaves = visibleLeaves(current.layers).filter((layer) => !isFolder(layer) && layer.isVisible !== false)
  for (let index = leaves.length - 1; index >= 0; index -= 1) {
    if (containsPoint(leaves[index].transform, x, y)) return leaves[index].id
  }
  return null
}

function onPointerDown(event: PointerEvent): void {
  const element = host.value
  if (!element) return
  // A pointer that has already been released, or one a test dispatched by hand, has nothing to
  // capture; the drag still works, it just has no capture.
  try {
    element.setPointerCapture(event.pointerId)
  } catch {
    /* the pointer is not active */
  }
  const [sx, sy] = localPoint(event)
  const [dx, dy] = toDocument(sx, sy)

  if (event.button === 1 || event.button === 2 || spaceHeld || tool.value === 'hand') {
    drag = { kind: 'pan', lastX: sx, lastY: sy }
    return
  }

  switch (tool.value) {
    case 'zoom':
      drag = { kind: 'zoom', out: event.altKey }
      zoomAt(event.altKey ? 1 / 1.6 : 1.6, sx, sy)
      schedule()
      return
    case 'marqueeRect':
    case 'marqueeEllipse': {
      drag = {
        kind: 'marquee',
        start: [dx, dy],
        current: [dx, dy],
        elliptical: tool.value === 'marqueeEllipse',
      }
      return
    }
    case 'lasso': {
      // A lasso is a marquee whose shape is the path the pointer took.
      drag = { kind: 'lasso', points: [[dx, dy]] }
      setSelection(null)
      return
    }
    case 'crop': {
      // A press inside the rectangle that is already there starts a new one, as Photoshop's
      // crop tool does.
      drag = { kind: 'crop', start: [dx, dy], current: [dx, dy] }
      setCropRect({ x: dx, y: dy, width: 0, height: 0 })
      return
    }
    case 'gradient':
    case 'shape': {
      drag = { kind: tool.value === 'gradient' ? 'gradient' : 'shape', start: [dx, dy], current: [dx, dy] }
      return
    }
    case 'brush':
    case 'eraser':
      drag = { kind: 'paint' }
      beginStroke(dx, dy)
      schedule()
      return
    case 'eyedropper':
      pickColor(dx, dy)
      return
    case 'wand':
      // The fill needs the composited canvas, which is a readback, so it is not part of the drag
      // machinery: one press, one selection.
      void magicWandAt(dx, dy, wandTolerance.value, wandContiguous.value)
      return
    case 'move': {
      // A press on a handle transforms; a press anywhere else moves. That is one tool doing the two
      // things Photoshop's Move tool does.
      const handle = handleAt(dx, dy)
      const active = manifest.value?.layers.find((record) => record.id === activeLayerId.value)
      if (handle && active && !isFolder(active) && active.imageFile !== undefined) {
        const [ax, ay] = oppositeCorner(handle, active.transform)
        const centreX = active.transform.origin[0] + active.transform.size[0] / 2
        const centreY = active.transform.origin[1] + active.transform.size[1] / 2
        beginEdit('Transform Layer')
        drag = {
          kind: 'transform',
          layerId: active.id,
          handle,
          start: {
            ...active.transform,
            origin: [...active.transform.origin] as [number, number],
            size: [...active.transform.size] as [number, number],
          },
          anchor: [ax, ay],
          startAngle: Math.atan2(dy - centreY, dx - centreX),
        }
        return
      }
      const hit = topmostLayerAt(dx, dy)
      if (hit) selectLayer(hit, event.shiftKey)
      const layer = manifest.value?.layers.find((record) => record.id === (hit ?? activeLayerId.value))
      if (!layer || isFolder(layer)) return
      beginEdit('Move Layer')
      drag = {
        kind: 'move',
        layerId: layer.id,
        startOrigin: [layer.transform.origin[0], layer.transform.origin[1]],
        startPointer: [dx, dy],
      }
      return
    }
    default: {
      const hit = topmostLayerAt(dx, dy)
      if (hit) selectLayer(hit, event.shiftKey)
      else {
        activeLayerId.value = null
        selectedIds.value = []
      }
    }
  }
}

function onPointerMove(event: PointerEvent): void {
  const [sx, sy] = localPoint(event)
  pointer.value = [sx, sy]
  const [dx, dy] = toDocument(sx, sy)

  const dragging = drag
  switch (dragging.kind) {
    case 'none':
      return
    case 'pan':
      panBy(sx - dragging.lastX, sy - dragging.lastY)
      dragging.lastX = sx
      dragging.lastY = sy
      schedule()
      return
    case 'marquee':
      dragging.current = [dx, dy]
      // The mode is applied once, when the drag ends: applying it per move would combine the
      // half-drawn shape over and over with itself.
      setSelection(marqueeSelection(dragging.start, dragging.current, dragging.elliptical))
      return
    case 'lasso':
      dragging.points.push([dx, dy])
      setSelection(polygonSelection(dragging.points))
      return
    case 'gradient':
    case 'shape':
      dragging.current = [dx, dy]
      previewDrag.value = { kind: dragging.kind, from: dragging.start, to: dragging.current }
      return
    case 'crop':
      dragging.current = [dx, dy]
      setCropRect({
        x: Math.min(dragging.start[0], dx),
        y: Math.min(dragging.start[1], dy),
        width: Math.abs(dx - dragging.start[0]),
        height: Math.abs(dy - dragging.start[1]),
      })
      return
    case 'paint':
      extendStroke(dx, dy)
      schedule()
      return
    case 'move': {
      const current = manifest.value
      const record = current?.layers.find((item) => item.id === dragging.layerId)
      if (!record || !current) return
      let nx = dragging.startOrigin[0] + (dx - dragging.startPointer[0])
      let ny = dragging.startOrigin[1] + (dy - dragging.startPointer[1])
      if (event.shiftKey) {
        // Shift locks the drag to one axis, whichever it has moved further along.
        if (Math.abs(dx - dragging.startPointer[0]) > Math.abs(dy - dragging.startPointer[1])) {
          ny = dragging.startOrigin[1]
        } else {
          nx = dragging.startOrigin[0]
        }
      }
      const tolerance = 6 / Math.max(view.zoom, 1e-6)
      const snapped = snapMove(record, nx, ny, tolerance)
      // The origin is written straight through so the canvas tracks the pointer; the undo step is
      // opened once, below, and closed when the drag ends.
      record.transform.origin[0] = snapped.x
      record.transform.origin[1] = snapped.y
      dragGuides.value = { x: snapped.guidesX, y: snapped.guidesY }
      return
    }
    case 'transform': {
      const current = manifest.value
      const record = current?.layers.find((item) => item.id === dragging.layerId)
      if (!current || !record) return
      applyTransformDrag(record, dragging, dx, dy, event.shiftKey)
      return
    }
    case 'zoom':
      return
  }
}

/**
 * One step of a handle drag.
 *
 * Scaling keeps the opposite corner where it is, which is why the anchor is captured when the drag
 * starts: recomputing it each frame from the moving rectangle would let the layer creep across the
 * canvas. Rotation is measured from the layer's centre, and Shift snaps it to 15 degrees.
 */
function applyTransformDrag(
  layer: { transform: Transform },
  dragging: Extract<Drag, { kind: 'transform' }>,
  dx: number,
  dy: number,
  shift: boolean,
): void {
  const start = dragging.start
  const radians = (start.rotation * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const [ax, ay] = dragging.anchor

  if (dragging.handle === 'rotate') {
    const centreX = start.origin[0] + start.size[0] / 2
    const centreY = start.origin[1] + start.size[1] / 2
    const turned = Math.atan2(dy - centreY, dx - centreX) - dragging.startAngle
    let degrees = start.rotation + (turned * 180) / Math.PI
    if (shift) degrees = Math.round(degrees / 15) * 15
    layer.transform.rotation = Math.round(degrees * 100) / 100
    return
  }

  // The pointer, in the layer's own unrotated frame, relative to the fixed corner.
  const localX = (dx - ax) * cos + (dy - ay) * sin
  const localY = -(dx - ax) * sin + (dy - ay) * cos
  let width = Math.abs(localX)
  let height = Math.abs(localY)
  // An edge handle moves one side only.
  if (dragging.handle === 'n' || dragging.handle === 's') width = start.size[0]
  if (dragging.handle === 'e' || dragging.handle === 'w') height = start.size[1]
  if (shift && width > 0 && height > 0) {
    // Snap to the layer's starting aspect ratio, whichever side the pointer moved further along.
    const ratio = start.size[0] / Math.max(start.size[1], 1e-6)
    if (width / height > ratio) height = width / ratio
    else width = height * ratio
  }
  width = Math.max(1, width)
  height = Math.max(1, height)

  // Put the fixed corner back where it was, then derive the origin from the new centre.
  const centreLocalX = (localX < 0 ? -width : width) / 2
  const centreLocalY = (localY < 0 ? -height : height) / 2
  const centreX = ax + centreLocalX * cos - centreLocalY * sin
  const centreY = ay + centreLocalX * sin + centreLocalY * cos

  layer.transform.size[0] = width
  layer.transform.size[1] = height
  layer.transform.origin[0] = centreX - width / 2
  layer.transform.origin[1] = centreY - height / 2
}

function onPointerUp(event: PointerEvent): void {
  const element = host.value
  try {
    element?.releasePointerCapture(event.pointerId)
  } catch {
    /* the pointer was never captured */
  }
  switch (drag.kind) {
    case 'paint':
      endStroke()
      break
    case 'marquee': {
      const drawn = marqueeSelection(drag.start, drag.current, drag.elliptical)
      applySelectionMode(drawn)
      break
    }
    case 'lasso':
      applySelectionMode(polygonSelection(drag.points))
      break
    case 'crop': {
      const rect = cropRect.value
      // A crop smaller than a few pixels is a stray click, not a crop.
      if (!rect || rect.width < 4 || rect.height < 4) setCropRect(null)
      break
    }
    case 'gradient':
      previewDrag.value = null
      drawGradient(drag.start, drag.current)
      break
    case 'shape':
      previewDrag.value = null
      drawShape(drag.start, drag.current, shape.filled)
      break
    case 'move':
      dragGuides.value = { x: [], y: [] }
      // One undo step for the whole drag, and none at all if it ended where it started.
      endEdit()
      break
    case 'transform':
      endEdit()
      break
    default:
      break
  }
  drag = { kind: 'none' }
  schedule()
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const [sx, sy] = localPoint(event)
  if (event.ctrlKey || event.metaKey || event.altKey || (event.deltaMode === 0 && event.deltaY === 0)) {
    zoomAt(Math.exp(-event.deltaY * 0.002), sx, sy)
  } else {
    panBy(-event.deltaX, -event.deltaY)
  }
  schedule()
}

// MARK: - Dropping files

function onDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  dropActive.value = true
}

function onDragLeave(): void {
  dropActive.value = false
}

async function onDrop(event: DragEvent): Promise<void> {
  dropActive.value = false
  const files = [...(event.dataTransfer?.files ?? [])]
  if (files.length === 0) return
  event.preventDefault()
  await importDroppedFiles(files)
}

// MARK: - Keyboard

function onKeyDown(event: KeyboardEvent): void {
  if (event.code === 'Space' && !event.repeat) {
    spaceHeld = true
    event.preventDefault()
  }
  if (event.key === 'Escape' && (drag.kind === 'marquee' || drag.kind === 'lasso')) {
    setSelection(null)
    drag = { kind: 'none' }
  }
  if (event.key === 'Enter' && cropRect.value && tool.value === 'crop') applyCrop()
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.code === 'Space') spaceHeld = false
}

// MARK: - Lifecycle

onMounted(async () => {
  trace.mounts += 1
  const element = canvas.value
  const wrapper = host.value
  if (!element || !wrapper) {
    trace.skipped.push('mount: missing element')
    return
  }
  observer = new ResizeObserver(() => {
    viewport.width = wrapper.clientWidth * (window.devicePixelRatio || 1)
    viewport.height = wrapper.clientHeight * (window.devicePixelRatio || 1)
    schedule()
  })
  observer.observe(wrapper)
  viewport.width = wrapper.clientWidth * (window.devicePixelRatio || 1)
  viewport.height = wrapper.clientHeight * (window.devicePixelRatio || 1)

  await attachCanvas(element)
  await registerDropTarget()
  fit()
  schedule()

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  // A hidden window has its animation frames suspended, so the frame drawn before it went away is
  // the last one there is. Coming back is what has to ask for a new one.
  document.addEventListener('visibilitychange', onVisibility)
})

function onVisibility(): void {
  if (document.visibilityState === 'visible') schedule()
}

onBeforeUnmount(() => {
  observer?.disconnect()
  if (frame) cancelAnimationFrame(frame)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  document.removeEventListener('visibilitychange', onVisibility)
  detachCanvas()
})

watch(
  [() => draws.value, () => view.zoom, () => view.panX, () => view.panY, () => selection.value],
  schedule,
)
</script>

<template>
  <div
    ref="host"
    class="stage"
    :class="{ 'stage--pan': spaceHeld || tool === 'hand', 'stage--drop': dropActive }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel="onWheel"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @contextmenu.prevent
  >
    <canvas ref="canvas" class="stage__canvas" />

    <svg v-if="documentRect" class="stage__overlay">
      <g class="ants">
        <path v-if="selection" class="ants__under" :transform="`translate(${view.panX} ${view.panY}) scale(${view.zoom})`" :d="selectionOutline(selection, manifest?.width ?? 0, manifest?.height ?? 0)" />
        <path v-if="selection" class="ants__over" :transform="`translate(${view.panX} ${view.panY}) scale(${view.zoom})`" :d="selectionOutline(selection, manifest?.width ?? 0, manifest?.height ?? 0)" />
      </g>
      <line
        v-if="previewDrag"
        class="drag-line"
        :x1="previewDrag.from[0] * view.zoom + view.panX"
        :y1="previewDrag.from[1] * view.zoom + view.panY"
        :x2="previewDrag.to[0] * view.zoom + view.panX"
        :y2="previewDrag.to[1] * view.zoom + view.panY"
      />
      <g v-if="cropRect">
        <path
          class="crop__shade"
          :d="`M0 0H${viewport.width / viewport.dpr}V${viewport.height / viewport.dpr}H0Z ` +
            `M${cropRect.x * view.zoom + view.panX} ${cropRect.y * view.zoom + view.panY}` +
            `h${cropRect.width * view.zoom}v${cropRect.height * view.zoom}h${-cropRect.width * view.zoom}Z`"
          fill-rule="evenodd"
        />
        <rect
          class="crop__frame"
          :x="cropRect.x * view.zoom + view.panX"
          :y="cropRect.y * view.zoom + view.panY"
          :width="cropRect.width * view.zoom"
          :height="cropRect.height * view.zoom"
        />
      </g>
      <polygon v-if="transformBox" class="frame" :points="transformBox" />
      <circle
        v-for="handle in transformHandles"
        :key="handle.id"
        class="handle"
        :class="{ 'handle--rotate': handle.id === 'rotate' }"
        :cx="handle.x * view.zoom + view.panX"
        :cy="handle.y * view.zoom + view.panY"
        :r="handle.id === 'rotate' ? 4 : 3.5"
      />
      <line
        v-for="line in guideLines"
        :key="line.id"
        class="guide"
        :x1="line.vertical ? line.offset : 0"
        :x2="line.vertical ? line.offset : viewport.width"
        :y1="line.vertical ? 0 : line.offset"
        :y2="line.vertical ? viewport.height : line.offset"
      />
    </svg>

    <div
      v-if="brushCursor"
      class="stage__brush"
      :style="{
        left: `${brushCursor.left}px`,
        top: `${brushCursor.top}px`,
        width: `${brushCursor.size}px`,
        height: `${brushCursor.size}px`,
      }"
    />

    <div v-if="dropActive" class="stage__dropping">{{ t('canvas.dropHere') }}</div>

    <div v-if="!canGPU" class="stage__notice">
      <strong>{{ t('canvas.noGpuTitle') }}</strong>
      <p>{{ message ?? t('canvas.noGpuBody') }}</p>
    </div>
    <div v-else-if="!canRender || !manifest" class="stage__notice">
      <strong>{{ t('canvas.noDocumentTitle') }}</strong>
      <p>{{ t('canvas.noDocumentBody') }}</p>
    </div>
  </div>
</template>

<style scoped>
.stage {
  position: relative;
  overflow: hidden;
  background: var(--ps-canvas);
  touch-action: none;
}

.stage--pan {
  cursor: grab;
}

.stage--drop {
  box-shadow: inset 0 0 0 2px var(--ps-accent);
}

.stage__canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.stage__overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.ants__under,
.ants__over {
  fill: none;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.ants__under {
  stroke: #ffffff;
}

.ants__over {
  stroke: #000000;
  stroke-dasharray: 4 4;
  animation: ants 0.6s linear infinite;
}

@keyframes ants {
  to {
    stroke-dashoffset: -8;
  }
}

.drag-line {
  stroke: #ffffff;
  stroke-width: 1;
  stroke-dasharray: 4 3;
  vector-effect: non-scaling-stroke;
}

.crop__shade {
  fill: rgb(0 0 0 / 55%);
}

.crop__frame {
  fill: none;
  stroke: #ffffff;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.handle {
  fill: #ffffff;
  stroke: #1a1a1a;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.handle--rotate {
  fill: #cfe4fb;
}

.frame {
  fill: none;
  stroke: #a8c8e8;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  stroke-dasharray: 4 3;
}

.guide {
  stroke: #35c8ff;
  stroke-width: 1;
  opacity: 0.8;
  vector-effect: non-scaling-stroke;
}

.stage__brush {
  position: absolute;
  border: 1px solid rgb(255 255 255 / 85%);
  border-radius: 50%;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 0 1px rgb(0 0 0 / 55%);
  pointer-events: none;
}

.stage__dropping {
  position: absolute;
  inset: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed var(--ps-accent);
  color: #cfe4fb;
  background: rgb(45 140 235 / 12%);
  pointer-events: none;
}

.stage__notice {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  color: var(--ps-text-dim);
  text-align: center;
  pointer-events: none;
}

.stage__notice strong {
  color: var(--ps-text-strong);
  font-weight: 600;
}
</style>
