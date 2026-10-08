<script setup lang="ts">
/**
 * The window: a command bar, the canvas, the layer stack and its properties.
 *
 * Keyboard handling lives here rather than in the canvas so that a shortcut works wherever focus
 * is — except while a text field has it, which is what Photoshop does too.
 */
import { onBeforeUnmount, onMounted } from 'vue'

import CanvasStage from './components/CanvasStage.vue'
import LayersPanel from './components/LayersPanel.vue'
import PropertiesPanel from './components/PropertiesPanel.vue'
import StatusBar from './components/StatusBar.vue'
import Toolbar from './components/Toolbar.vue'
import {
  addBlankLayer,
  deleteSelected,
  duplicateSelected,
  exportPNG,
  fit,
  groupSelected,
  moveActive,
  openProject,
  redo,
  saveProject,
  undo,
  ungroupSelected,
  zoomTo,
} from './state/session'

const TOOLS = [
  { label: 'Move', hint: 'V' },
  { label: 'Marquee', hint: 'M' },
  { label: 'Lasso', hint: 'L' },
  { label: 'Magic', hint: 'W' },
  { label: 'Crop', hint: 'C' },
  { label: 'Brush', hint: 'B' },
  { label: 'Eraser', hint: 'E' },
  { label: 'Heal', hint: 'J' },
  { label: 'Clone', hint: 'S' },
  { label: 'Gradient', hint: 'G' },
  { label: 'Shape', hint: 'U' },
  { label: 'Type', hint: 'T' },
  { label: 'Eyedropper', hint: 'I' },
  { label: 'Hand', hint: 'H' },
  { label: 'Zoom', hint: 'Z' },
]

function isTextEntry(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
}

function onKeyDown(event: KeyboardEvent): void {
  if (isTextEntry(event.target)) return

  if (event.ctrlKey || event.metaKey) {
    switch (event.key.toLowerCase()) {
      case 'z':
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      case 'y':
        event.preventDefault()
        redo()
        return
      case 's':
        event.preventDefault()
        void saveProject()
        return
      case 'o':
        event.preventDefault()
        void openProject()
        return
      case 'e':
        event.preventDefault()
        void exportPNG()
        return
      case '0':
        event.preventDefault()
        fit()
        return
      case '1':
        event.preventDefault()
        zoomTo(1)
        return
      case 'g':
        event.preventDefault()
        if (event.shiftKey) ungroupSelected()
        else groupSelected()
        return
      case 'j':
        event.preventDefault()
        duplicateSelected()
        return
      default:
        return
    }
  }

  switch (event.key) {
    case ']':
      event.preventDefault()
      moveActive(1)
      break
    case '[':
      event.preventDefault()
      moveActive(-1)
      break
    case 'Delete':
    case 'Backspace':
      event.preventDefault()
      deleteSelected()
      break
    case 'Escape':
      break
    default:
      if (event.key.toLowerCase() === 'n' && event.shiftKey) {
        event.preventDefault()
        addBlankLayer()
      }
  }
}

onMounted(() => window.addEventListener('keydown', onKeyDown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
</script>

<template>
  <div class="window">
    <Toolbar />
    <div class="window__body">
      <nav class="rail">
        <button
          v-for="tool in TOOLS"
          :key="tool.label"
          class="rail__tool"
          :disabled="tool.label !== 'Move'"
          :title="tool.label !== 'Move' ? `${tool.label} — not in this build yet` : tool.label"
        >
          <span class="rail__label">{{ tool.label }}</span>
          <span class="rail__hint">{{ tool.hint }}</span>
        </button>
      </nav>

      <main class="window__canvas">
        <CanvasStage />
      </main>

      <aside class="window__side">
        <LayersPanel />
        <PropertiesPanel />
      </aside>
    </div>
    <StatusBar />
  </div>
</template>

<style scoped>
.window {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.window__body {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) 300px;
  flex: 1;
  min-height: 0;
}

.window__canvas {
  position: relative;
  min-width: 0;
}

.window__side {
  display: grid;
  grid-template-rows: minmax(120px, 1fr) auto;
  min-height: 0;
  border-left: 1px solid #33353a;
}

.rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 4px;
  background: #2b2c31;
  border-right: 1px solid #33353a;
  overflow: auto;
}

.rail__tool {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 5px 2px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: none;
  color: #b6bbc3;
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}

.rail__tool:disabled {
  opacity: 0.4;
  cursor: default;
}

.rail__hint {
  color: #656b75;
  font-size: 9px;
}
</style>
