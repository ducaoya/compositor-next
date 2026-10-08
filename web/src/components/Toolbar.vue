<script setup lang="ts">
/** The command bar. Every action here is a session call, so nothing is done twice. */
import { computed } from 'vue'

import {
  addBlankLayer,
  addFolder,
  canRedo,
  canUndo,
  deleteSelected,
  duplicateSelected,
  exportPNG,
  fit,
  groupSelected,
  moveActive,
  newProject,
  openProject,
  redo,
  saveProject,
  undo,
  ungroupSelected,
  useSession,
  zoomBy,
  zoomTo,
} from '../state/session'

const { busy, dirty, activeLayerId, limits } = useSession()

const canSave = computed(() => dirty.value && activeLayerId.value !== undefined)

async function onNew(): Promise<void> {
  const width = Number(prompt('Canvas width', '1920'))
  const height = Number(prompt('Canvas height', '1080'))
  if (!Number.isFinite(width) || !Number.isFinite(height)) return
  if (width < 1 || height < 1 || width > limits.value.maxSide || height > limits.value.maxSide) return
  await newProject(Math.round(width), Math.round(height))
}
</script>

<template>
  <header class="toolbar">
    <div class="toolbar__group">
      <button class="tool" :disabled="busy" @click="onNew">New…</button>
      <button class="tool" :disabled="busy" @click="openProject">Open…</button>
      <button class="tool tool--primary" :disabled="busy || !canSave" @click="saveProject">Save</button>
      <button class="tool" :disabled="busy" @click="exportPNG">Export PNG</button>
    </div>

    <div class="toolbar__group">
      <button class="tool" :disabled="!canUndo" @click="undo">Undo</button>
      <button class="tool" :disabled="!canRedo" @click="redo">Redo</button>
    </div>

    <div class="toolbar__group">
      <button class="tool" @click="addBlankLayer">+ Layer</button>
      <button class="tool" @click="addFolder">+ Folder</button>
      <button class="tool" @click="duplicateSelected">Duplicate</button>
      <button class="tool" @click="groupSelected">Group</button>
      <button class="tool" @click="ungroupSelected">Ungroup</button>
      <button class="tool" @click="moveActive(1)">Raise</button>
      <button class="tool" @click="moveActive(-1)">Lower</button>
      <button class="tool tool--danger" @click="deleteSelected">Delete</button>
    </div>

    <div class="toolbar__group toolbar__group--right">
      <button class="tool" @click="zoomBy(1 / 1.25)">−</button>
      <button class="tool" @click="zoomTo(1)">100%</button>
      <button class="tool" @click="zoomBy(1.25)">+</button>
      <button class="tool" @click="fit">Fit</button>
    </div>
  </header>
</template>

<style scoped>
.toolbar {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 8px 10px;
  background: #2b2c31;
  border-bottom: 1px solid #33353a;
}

.toolbar__group {
  display: flex;
  gap: 4px;
}

.toolbar__group--right {
  margin-left: auto;
}

.tool {
  padding: 5px 10px;
  border: 1px solid #3c3f46;
  border-radius: 4px;
  background: #33353b;
  color: #d6d9df;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.tool:hover:not(:disabled) {
  background: #3d4047;
}

.tool:disabled {
  opacity: 0.4;
  cursor: default;
}

.tool--primary {
  background: #3f6ea8;
  border-color: #4b7fbe;
}

.tool--primary:hover:not(:disabled) {
  background: #4879b6;
}

.tool--danger:hover:not(:disabled) {
  background: #7a3538;
  border-color: #8f4044;
}
</style>
