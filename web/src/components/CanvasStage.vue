<script setup lang="ts">
/**
 * The canvas.
 *
 * Owns the WebGPU surface and the pointer and wheel behaviours. Rendering is scheduled rather than
 * continuous: a change to the document or the view marks the frame dirty, and one animation frame
 * later the compositor draws it. Panning is the only thing that runs for as long as the pointer
 * moves, and even that goes through the same scheduler.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { containsPoint } from '../model/document'
import { isFolder, visibleLeaves } from '../model/types'
import {
  attachCanvas,
  detachCanvas,
  draws,
  fit,
  panBy,
  selectLayer,
  toDocument,
  useSession,
  zoomAt,
} from '../state/session'

const { manifest, canRender, canGPU, message, view, viewport, activeLayerId, selectedIds } = useSession()

const host = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const hoverPoint = ref<[number, number] | null>(null)

let frame = 0
let needsRender = true
let observer: ResizeObserver | null = null
let panning: { x: number; y: number; moved: boolean } | null = null
let spaceHeld = false

/** Counters for scripted checks: the render loop is otherwise invisible from outside. */
const trace = { mounts: 0, schedules: 0, renders: 0, skipped: [] as string[], errors: [] as string[] }
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__stageTrace', { value: trace, configurable: true })
}

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

/** Where the document sits on screen, in CSS pixels, for the border and the guides. */
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
  return (current.guides ?? []).map((guide) => {
    const position = guide.position * view.zoom
    return guide.axis === 'vertical'
      ? { id: guide.id, vertical: true, offset: rect.left + position }
      : { id: guide.id, vertical: false, offset: rect.top + position }
  })
})

/** The topmost layer under a document point, so a click selects what is visible. */
function layerAt(x: number, y: number): string | null {
  const current = manifest.value
  if (!current) return null
  const leaves = visibleLeaves(current.layers).filter(
    (layer) => !isFolder(layer) && layer.isVisible !== false,
  )
  for (let index = leaves.length - 1; index >= 0; index -= 1) {
    const layer = leaves[index]
    if (containsPoint(layer.transform, x, y)) return layer.id
  }
  return null
}

function onPointerDown(event: PointerEvent): void {
  const element = host.value
  if (!element) return
  element.setPointerCapture(event.pointerId)
  const wantsPan = event.button === 1 || spaceHeld || event.button === 2
  if (wantsPan) {
    panning = { x: event.clientX, y: event.clientY, moved: false }
    return
  }
  const bounds = element.getBoundingClientRect()
  const [x, y] = toDocument(event.clientX - bounds.left, event.clientY - bounds.top)
  const hit = layerAt(x, y)
  if (hit) selectLayer(hit, event.shiftKey)
  else {
    activeLayerId.value = null
    selectedIds.value = []
  }
}

function onPointerMove(event: PointerEvent): void {
  const element = host.value
  if (!element) return
  const bounds = element.getBoundingClientRect()
  if (panning) {
    panBy(event.clientX - panning.x, event.clientY - panning.y)
    panning.x = event.clientX
    panning.y = event.clientY
    panning.moved = true
    schedule()
    return
  }
  const [x, y] = toDocument(event.clientX - bounds.left, event.clientY - bounds.top)
  hoverPoint.value = [Math.floor(x), Math.floor(y)]
}

function endPan(event: PointerEvent): void {
  if (panning) host.value?.releasePointerCapture(event.pointerId)
  panning = null
}

function onWheel(event: WheelEvent): void {
  const element = host.value
  if (!element) return
  event.preventDefault()
  const bounds = element.getBoundingClientRect()
  if (event.ctrlKey || event.metaKey || event.altKey) {
    const factor = Math.exp(-event.deltaY * 0.002)
    zoomAt(factor, event.clientX - bounds.left, event.clientY - bounds.top)
  } else {
    panBy(-event.deltaX, -event.deltaY)
  }
  schedule()
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.code === 'Space' && !event.repeat) {
    spaceHeld = true
    // Space would otherwise scroll the panel behind the canvas.
    event.preventDefault()
  }
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.code === 'Space') spaceHeld = false
}

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
  fit()
  schedule()

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  if (frame) cancelAnimationFrame(frame)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  detachCanvas()
})

watch([() => draws.value, () => view.zoom, () => view.panX, () => view.panY], schedule, { deep: false })
</script>

<template>
  <div
    ref="host"
    class="stage"
    :class="{ 'stage--panning': spaceHeld }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="endPan"
    @pointercancel="endPan"
    @wheel="onWheel"
    @contextmenu.prevent
  >
    <canvas ref="canvas" class="stage__canvas" />

    <template v-if="documentRect">
      <div
        class="stage__document"
        :style="{
          left: `${documentRect.left}px`,
          top: `${documentRect.top}px`,
          width: `${documentRect.width}px`,
          height: `${documentRect.height}px`,
        }"
      />
      <div
        v-for="line in guideLines"
        :key="line.id"
        class="stage__guide"
        :class="line.vertical ? 'stage__guide--vertical' : 'stage__guide--horizontal'"
        :style="line.vertical ? { left: `${line.offset}px` } : { top: `${line.offset}px` }"
      />
    </template>

    <div v-if="!canGPU" class="stage__notice">
      <strong>WebGPU is unavailable</strong>
      <p>{{ message ?? 'This build composites on the GPU and needs a browser that supports it.' }}</p>
    </div>
    <div v-else-if="!canRender" class="stage__notice">
      <strong>No document open</strong>
      <p>Open a <code>.comp</code> project, or start a new canvas.</p>
    </div>
  </div>
</template>

<style scoped>
.stage {
  position: relative;
  overflow: hidden;
  background: #212226;
  cursor: default;
  touch-action: none;
}

.stage--panning {
  cursor: grab;
}

.stage__canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.stage__document {
  position: absolute;
  pointer-events: none;
  outline: 1px solid rgb(255 255 255 / 25%);
  box-shadow: 0 0 0 1px rgb(0 0 0 / 40%);
}

.stage__guide {
  position: absolute;
  pointer-events: none;
  background: #35c8ff;
  opacity: 0.7;
}

.stage__guide--vertical {
  top: 0;
  bottom: 0;
  width: 1px;
}

.stage__guide--horizontal {
  left: 0;
  right: 0;
  height: 1px;
}

.stage__notice {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  color: #9aa0ab;
  text-align: center;
  pointer-events: none;
}

.stage__notice strong {
  color: #d6d9df;
  font-weight: 600;
}
</style>
