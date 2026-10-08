<script setup lang="ts">
/**
 * The layer list, top to bottom as Photoshop shows it.
 *
 * Rows are flattened from the tree with a depth and an inherited visibility flag, so a folder that
 * is turned off dims everything inside it without touching the children's own flags.
 */
import { computed, nextTick, ref } from 'vue'

import { moveLayerTo } from '../model/document'
import { isFolder } from '../model/types'
import {
  beginEdit,
  endEdit,
  hasTexture,
  historyCancel,
  renameLayer,
  selectLayer,
  toggleCollapsed,
  toggleVisible,
  useSession,
} from '../state/session'

const { manifest, rows, activeLayerId, selectedIds, collapsed, project } = useSession()

const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const dragId = ref<string | null>(null)
const dropTargetId = ref<string | null>(null)

/** A thumbnail URL for a layer, straight from the decoded project assets. */
function thumbnail(layerId: string): string | null {
  const opened = project.value
  if (!opened) return null
  return opened.assets.find((asset) => asset.layerId === layerId && asset.kind === 'image')?.url ?? null
}

function maskThumbnail(layerId: string): string | null {
  const opened = project.value
  if (!opened) return null
  return opened.assets.find((asset) => asset.layerId === layerId && asset.kind === 'mask')?.url ?? null
}

function beginRename(id: string, name: string): void {
  renamingId.value = id
  renameDraft.value = name
  nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.layer-row__rename')
    input?.focus()
    input?.select()
  })
}

function finishRename(): void {
  const id = renamingId.value
  renamingId.value = null
  if (id) renameLayer(id, renameDraft.value)
}

function onDragStart(id: string, event: DragEvent): void {
  dragId.value = id
  event.dataTransfer?.setData('text/plain', id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDrop(targetId: string): void {
  const source = dragId.value
  dragId.value = null
  dropTargetId.value = null
  if (!source || !targetId || source === targetId || !manifest.value) return
  // `manifest` is deeply reactive, so an in-place mutation already redraws the tree; the history
  // step is opened and closed around it so the drop is one undo.
  beginEdit('Reorder Layers')
  const moved = moveLayerTo(manifest.value, source, targetId)
  if (moved) endEdit()
  else historyCancel()
  if (moved) selectLayer(source, false)
}

const total = computed(() => manifest.value?.layers.length ?? 0)
</script>

<template>
  <section class="layers">
    <header class="layers__head">
      <h2>Layers</h2>
      <span class="layers__count">{{ total }}</span>
    </header>

    <div class="layers__rows" @dragover.prevent>
      <div
        v-for="row in rows"
        :key="row.layer.id"
        class="layer-row"
        :class="{
          'layer-row--active': row.layer.id === activeLayerId,
          'layer-row--selected': selectedIds.includes(row.layer.id),
          'layer-row--hidden': !row.visible,
          'layer-row--drop': dropTargetId === row.layer.id,
        }"
        :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
        draggable="true"
        @dragstart="onDragStart(row.layer.id, $event)"
        @dragover.prevent="dropTargetId = row.layer.id"
        @dragleave="dropTargetId = dropTargetId === row.layer.id ? null : dropTargetId"
        @drop.prevent="onDrop(row.layer.id)"
        @click="selectLayer(row.layer.id, $event.shiftKey)"
      >
        <button
          v-if="isFolder(row.layer)"
          class="layer-row__twisty"
          :aria-label="collapsed.has(row.layer.id) ? 'Expand' : 'Collapse'"
          @click.stop="toggleCollapsed(row.layer.id)"
        >
          {{ collapsed.has(row.layer.id) ? '›' : '⌄' }}
        </button>
        <span v-else class="layer-row__twisty layer-row__twisty--empty" />

        <button
          class="layer-row__eye"
          :class="{ 'layer-row__eye--on': row.layer.isVisible !== false }"
          :aria-label="row.layer.isVisible !== false ? 'Hide layer' : 'Show layer'"
          @click.stop="toggleVisible(row.layer.id)"
        />

        <span class="layer-row__thumb">
          <img v-if="thumbnail(row.layer.id)" :src="thumbnail(row.layer.id)!" alt="" />
          <span v-else-if="isFolder(row.layer)" class="layer-row__folder">▤</span>
        </span>

        <input
          v-if="renamingId === row.layer.id"
          v-model="renameDraft"
          class="layer-row__rename"
          @keydown.enter.prevent="finishRename"
          @keydown.esc.prevent="renamingId = null"
          @blur="finishRename"
          @click.stop
        />
        <span
          v-else
          class="layer-row__name"
          @dblclick.stop="beginRename(row.layer.id, row.layer.name)"
          >{{ row.layer.name }}</span
        >

        <span v-if="row.layer.maskFile" class="layer-row__mask" title="Layer mask">
          <img v-if="maskThumbnail(row.layer.id)" :src="maskThumbnail(row.layer.id)!" alt="" />
        </span>
        <span v-if="row.layer.adjustment !== undefined" class="layer-row__badge" title="Adjustment layer">
          ◐
        </span>
        <span
          v-if="hasTexture(row.layer.id) === false && !isFolder(row.layer)"
          class="layer-row__badge"
          title="No pixels yet"
          >∅</span
        >
      </div>
    </div>
  </section>
</template>

<style scoped>
.layers {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: #26272b;
}

.layers__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid #33353a;
}

.layers__head h2 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #8d939e;
}

.layers__count {
  font-size: 11px;
  color: #6f7580;
}

.layers__rows {
  flex: 1;
  overflow: auto;
  padding: 4px 0;
}

.layer-row {
  display: flex;
  gap: 6px;
  align-items: center;
  height: 30px;
  padding-right: 8px;
  font-size: 12px;
  color: #c8ccd3;
  cursor: default;
  user-select: none;
}

.layer-row:hover {
  background: #2e3036;
}

.layer-row--active {
  background: #3a4a63;
}

.layer-row--selected:not(.layer-row--active) {
  background: #333a45;
}

.layer-row--hidden {
  opacity: 0.45;
}

.layer-row--drop {
  box-shadow: inset 0 1px 0 #4c9aff;
}

.layer-row__twisty {
  width: 14px;
  height: 14px;
  padding: 0;
  border: 0;
  background: none;
  color: #8d939e;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}

.layer-row__twisty--empty {
  display: inline-block;
}

.layer-row__eye {
  width: 14px;
  height: 14px;
  padding: 0;
  border: 1px solid #4a4d55;
  border-radius: 3px;
  background: none;
  cursor: pointer;
}

.layer-row__eye--on {
  background: #cfd4dc;
  border-color: #cfd4dc;
}

.layer-row__thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid #40434a;
  border-radius: 2px;
  background: repeating-conic-gradient(#3a3c42 0 25%, #32343a 0 50%) 0 0 / 8px 8px;
  overflow: hidden;
  flex: none;
}

.layer-row__thumb img {
  max-width: 100%;
  max-height: 100%;
}

.layer-row__folder {
  color: #8d939e;
  font-size: 12px;
}

.layer-row__name {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.layer-row__rename {
  flex: 1;
  min-width: 0;
  border: 1px solid #4c9aff;
  border-radius: 2px;
  background: #1c1d21;
  color: #e6e8ec;
  font: inherit;
  padding: 1px 4px;
}

.layer-row__mask {
  width: 18px;
  height: 18px;
  border: 1px solid #565a63;
  border-radius: 2px;
  overflow: hidden;
  flex: none;
}

.layer-row__mask img {
  width: 100%;
  height: 100%;
}

.layer-row__badge {
  color: #7d838d;
  font-size: 11px;
  flex: none;
}
</style>
