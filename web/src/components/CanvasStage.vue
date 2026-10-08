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
import { selectionOutline } from '../model/selection'
import { isFolder, visibleLeaves } from '../model/types'
import {
  attachCanvas,
  beginEdit,
  beginStroke,
  detachCanvas,
  draws,
  endEdit,
  endStroke,
  extendStroke,
  fit,
  flushPaint,
  importDroppedFiles,
  layerMatrix,
  layerPixelSize,
  marqueeSelection,
  panBy,
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
const { manifest, canRender, canGPU, message, view, viewport, activeLayerId, selectedIds, tool, brush, selection } =
  useSession()

const host = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const pointer = ref<[number, number] | null>(null)
const dragGuides = ref<{ x: number[]; y: number[] }>({ x: [], y: [] })
const dropActive = ref(false)
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
  | { kind: 'paint' }
  | { kind: 'move'; layerId: string; startOrigin: [number, number]; startPointer: [number, number] }
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
    case 'brush':
    case 'eraser':
      drag = { kind: 'paint' }
      beginStroke(dx, dy)
      schedule()
      return
    case 'eyedropper':
      pickColor(dx, dy)
      return
    case 'move': {
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
      setSelection(marqueeSelection(dragging.start, dragging.current, dragging.elliptical))
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
    case 'zoom':
      return
  }
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
    case 'marquee':
      if (!marqueeSelection(drag.start, drag.current, drag.elliptical)) setSelection(null)
      break
    case 'move':
      dragGuides.value = { x: [], y: [] }
      // One undo step for the whole drag, and none at all if it ended where it started.
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
  if (event.key === 'Escape' && drag.kind === 'marquee') {
    setSelection(null)
    drag = { kind: 'none' }
  }
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
      <polygon v-if="transformBox" class="frame" :points="transformBox" />
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
