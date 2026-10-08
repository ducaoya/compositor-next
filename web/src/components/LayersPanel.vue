<script setup lang="ts">
/**
 * The Layers panel, arranged the way Photoshop arranges it: panel tabs at the top, blend mode and
 * opacity above the stack, the stack itself, and a row of buttons along the bottom.
 *
 * Rows are flattened from the tree with a depth and an inherited visibility flag, so a folder that
 * is turned off dims everything inside it without touching the children's own flags.
 */
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { moveLayerTo } from '../model/document'
import { BLEND_MODE_GROUPS, blendModeKey, isFolder, type BlendModeName } from '../model/types'
import {
  addBlankLayer,
  addFolder,
  beginEdit,
  deleteSelected,
  duplicateSelected,
  endEdit,
  groupSelected,
  hasTexture,
  historyCancel,
  renameLayer,
  selectLayer,
  setMaskSource,
  toggleCollapsed,
  toggleVisible,
  ungroupSelected,
  useSession,
} from '../state/session'

const { t } = useI18n()
const { manifest, rows, activeLayerId, selectedIds, collapsed, project, activeLayer } = useSession()

const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const dragId = ref<string | null>(null)
const dropTargetId = ref<string | null>(null)

function thumbnail(layerId: string, kind: 'image' | 'mask'): string | null {
  const opened = project.value
  if (!opened) return null
  return opened.assets.find((asset) => asset.layerId === layerId && asset.kind === kind)?.url ?? null
}

function beginRename(id: string, name: string): void {
  renamingId.value = id
  renameDraft.value = name
  nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.layer__rename')
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
  beginEdit('Reorder Layers')
  const moved = moveLayerTo(manifest.value, source, targetId)
  if (moved) endEdit()
  else historyCancel()
  if (moved) selectLayer(source, false)
}

function setOpacityFromSlider(value: string): void {
  const layer = activeLayer.value
  if (!layer) return
  const opacity = Number(value) / 100
  beginEdit('Opacity')
  layer.opacity = opacity
  endEdit()
}

function setBlend(mode: string): void {
  const layer = activeLayer.value
  if (!layer) return
  beginEdit('Blend Mode')
  layer.blendMode = mode as BlendModeName
  endEdit()
}

function toggleClipping(): void {
  const layer = activeLayer.value
  const current = manifest.value
  if (!layer || !current) return
  if (layer.maskSourceID) {
    setMaskSource(layer.id, null)
    return
  }
  const parent = layer.parentID ?? null
  const siblings = current.layers.filter((record) => (record.parentID ?? null) === parent)
  const at = siblings.findIndex((record) => record.id === layer.id)
  const below = at > 0 ? siblings[at - 1] : null
  if (below && !isFolder(below)) setMaskSource(layer.id, below.id)
}

const canClip = computed(() => {
  const layer = activeLayer.value
  return Boolean(layer && !isFolder(layer))
})

const count = computed(() => manifest.value?.layers.length ?? 0)
</script>

<template>
  <section class="panel">
    <header class="panel__tabs">
      <button class="panel__tab panel__tab--on">{{ t('layers.title') }}</button>
      <button class="panel__tab" disabled>{{ t('layers.channels') }}</button>
      <button class="panel__tab" disabled>{{ t('layers.paths') }}</button>
    </header>

    <div class="panel__controls">
      <div class="row">
        <span class="row__label">{{ t('layers.blend') }}</span>
        <select
          class="row__select"
          :value="activeLayer?.blendMode ?? 'Normal'"
          :disabled="!activeLayer || isFolder(activeLayer)"
          @change="setBlend(($event.target as HTMLSelectElement).value)"
        >
          <optgroup v-for="(group, index) in BLEND_MODE_GROUPS" :key="index" label="—">
            <option v-for="mode in group" :key="mode" :value="mode">
              {{ t(blendModeKey(mode)) }}
            </option>
          </optgroup>
        </select>
      </div>
      <div class="row">
        <span class="row__label">{{ t('layers.opacity') }}</span>
        <input
          class="row__slider"
          type="range"
          min="0"
          max="100"
          step="1"
          :value="Math.round((activeLayer?.opacity ?? 1) * 100)"
          :disabled="!activeLayer"
          @input="setOpacityFromSlider(($event.target as HTMLInputElement).value)"
        />
        <input
          class="row__number"
          type="number"
          min="0"
          max="100"
          :value="Math.round((activeLayer?.opacity ?? 1) * 100)"
          :disabled="!activeLayer"
          @change="setOpacityFromSlider(($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="row row--dim">
        <span class="row__label">{{ t('layers.fill') }}</span>
        <div class="row__bar" />
        <span class="row__number">100</span>
      </div>
      <div class="row row--dim">
        <span class="row__label">{{ t('layers.lock') }}</span>
        <span class="row__locks">
          <span :title="t('layers.lockTransparent')">▦</span>
          <span :title="t('layers.lockImage')">▤</span>
          <span :title="t('layers.lockPosition')">✥</span>
          <span :title="t('layers.lockAll')">▣</span>
        </span>
      </div>
    </div>

    <div class="panel__list">
      <div
        v-for="row in rows"
        :key="row.layer.id"
        class="layer"
        :class="{
          'layer--active': row.layer.id === activeLayerId,
          'layer--multi': selectedIds.includes(row.layer.id) && row.layer.id !== activeLayerId,
          'layer--hidden': !row.visible,
          'layer--drop': dropTargetId === row.layer.id,
        }"
        :style="{ paddingLeft: `${3 + row.depth * 12}px` }"
        draggable="true"
        @dragstart="onDragStart(row.layer.id, $event)"
        @dragover.prevent="dropTargetId = row.layer.id"
        @dragleave="dropTargetId = dropTargetId === row.layer.id ? null : dropTargetId"
        @drop.prevent="onDrop(row.layer.id)"
        @click="selectLayer(row.layer.id, $event.shiftKey)"
      >
        <button
          class="layer__twisty"
          :class="{ 'layer__twisty--empty': !isFolder(row.layer) }"
          @click.stop="isFolder(row.layer) && toggleCollapsed(row.layer.id)"
        >
          {{ isFolder(row.layer) ? (collapsed.has(row.layer.id) ? '▶' : '▼') : '' }}
        </button>

        <button
          class="layer__eye"
          :class="{ 'layer__eye--on': row.layer.isVisible !== false }"
          :title="row.layer.isVisible !== false ? t('layers.hide') : t('layers.show')"
          @click.stop="toggleVisible(row.layer.id)"
        >
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M1.4 8S3.8 3.6 8 3.6 14.6 8 14.6 8 12.2 12.4 8 12.4 1.4 8 1.4 8z" />
            <circle cx="8" cy="8" r="2.1" />
          </svg>
        </button>

        <span v-if="row.layer.maskSourceID" class="layer__link" :title="t('layers.clippingMask')">↳</span>
        <span v-else class="layer__link layer__link--empty" />

        <span class="layer__thumbs">
          <span class="layer__thumb" :class="{ 'layer__thumb--mask': !row.layer.imageFile && isFolder(row.layer) }">
            <img v-if="thumbnail(row.layer.id, 'image')" :src="thumbnail(row.layer.id, 'image')!" alt="" />
            <span v-else-if="isFolder(row.layer)" class="layer__folder">▤</span>
          </span>
          <span v-if="row.layer.maskFile" class="layer__thumb layer__thumb--mask">
            <img v-if="thumbnail(row.layer.id, 'mask')" :src="thumbnail(row.layer.id, 'mask')!" alt="" />
          </span>
        </span>

        <input
          v-if="renamingId === row.layer.id"
          v-model="renameDraft"
          class="layer__rename"
          @keydown.enter.prevent="finishRename"
          @keydown.esc.prevent="renamingId = null"
          @blur="finishRename"
          @click.stop
        />
        <span v-else class="layer__name" @dblclick.stop="beginRename(row.layer.id, row.layer.name)">
          {{ row.layer.name }}
        </span>

        <span v-if="row.layer.effects" class="layer__badge" title="fx">fx</span>
        <span v-if="row.layer.adjustment !== undefined" class="layer__badge" :title="t('layers.adjustmentLayer')">◐</span>
        <span
          v-if="!hasTexture(row.layer.id) && !isFolder(row.layer) && row.layer.imageFile"
          class="layer__badge layer__badge--warn"
          :title="t('layers.noPixels')"
          >∅</span
        >
      </div>
    </div>

    <footer class="panel__footer">
      <button class="icon" :disabled="!canClip" :title="t('layers.clippingMask')" @click="toggleClipping">↳</button>
      <button class="icon" disabled :title="t('layers.layerEffects')">fx</button>
      <button class="icon" disabled :title="t('layers.adjustmentLayer')">◐</button>
      <span class="panel__footer-gap" />
      <button class="icon" :title="t('layers.group')" @click="groupSelected">▤</button>
      <button class="icon" :title="t('layers.ungroup')" @click="ungroupSelected">▥</button>
      <button class="icon" :title="t('layers.newGroup')" @click="addFolder">🗀</button>
      <button class="icon" :title="t('layers.newLayer')" @click="addBlankLayer">+</button>
      <button class="icon" :title="t('layers.duplicate')" @click="duplicateSelected">⧉</button>
      <span class="panel__footer-gap" />
      <button class="icon" :title="t('layers.delete')" @click="deleteSelected">🗑</button>
      <span class="panel__count">{{ t('layers.count', { count }) }}</span>
    </footer>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--ps-panel);
}

/* Panel tabs */
.panel__tabs {
  display: flex;
  gap: 1px;
  padding: 3px 3px 0;
  background: var(--ps-frame-dark);
}

.panel__tab {
  padding: 4px 9px;
  border: 0;
  border-radius: 2px 2px 0 0;
  background: var(--ps-panel-tab);
  color: var(--ps-text-dim);
  font-size: 11px;
  cursor: pointer;
}

.panel__tab--on {
  background: var(--ps-panel);
  color: var(--ps-text-strong);
}

.panel__tab:disabled {
  opacity: 0.5;
  cursor: default;
}

/* Blend / opacity block */
.panel__controls {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 6px 7px;
  border-bottom: 1px solid var(--ps-line-hard);
  box-shadow: 0 1px 0 rgb(255 255 255 / 5%);
}

.row {
  display: flex;
  gap: 5px;
  align-items: center;
}

.row--dim {
  opacity: 0.42;
}

.row__label {
  width: 44px;
  color: var(--ps-text-dim);
}

.row__select {
  flex: 1;
  min-width: 0;
  padding: 1px 3px;
  border: 1px solid var(--ps-line);
  border-radius: var(--ps-radius);
  background: var(--ps-well);
  color: var(--ps-text);
}

.row__select:disabled {
  opacity: 0.5;
}

.row__slider {
  flex: 1;
  min-width: 0;
  height: 4px;
  accent-color: #9a9a9a;
}

.row__number {
  width: 40px;
  padding: 1px 3px;
  border: 1px solid var(--ps-line);
  border-radius: var(--ps-radius);
  background: var(--ps-well);
  color: var(--ps-text);
  text-align: right;
}

.row__bar {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--ps-line);
}

.row__locks {
  display: flex;
  gap: 3px;
  color: var(--ps-text);
}

/* The stack */
.panel__list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--ps-well);
  border-top: 1px solid var(--ps-line-hard);
}

.layer {
  display: flex;
  gap: 3px;
  align-items: center;
  height: 30px;
  padding-right: 5px;
  border-bottom: 1px solid #1f1f1f;
  color: var(--ps-text);
  cursor: default;
}

.layer:hover {
  background: #333333;
}

.layer--active {
  background: var(--ps-row-selected);
  color: #ffffff;
}

.layer--multi {
  background: var(--ps-row-selected-inactive);
}

.layer--hidden {
  color: var(--ps-text-faint);
}

.layer--drop {
  box-shadow: inset 0 1px 0 var(--ps-accent);
}

.layer__twisty {
  width: 10px;
  padding: 0;
  border: 0;
  background: none;
  color: #b0b0b0;
  font-size: 8px;
  line-height: 1;
  cursor: pointer;
}

.layer__twisty--empty {
  cursor: default;
}

.layer__eye {
  width: 16px;
  padding: 0;
  border: 0;
  background: none;
  color: #7a7a7a;
  cursor: pointer;
}

.layer__eye svg {
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.2;
}

.layer__eye--on {
  color: #dcdcdc;
}

.layer__link {
  width: 10px;
  color: #b8b8b8;
  font-size: 11px;
}

.layer__link--empty {
  opacity: 0;
}

.layer__thumbs {
  display: flex;
  gap: 2px;
}

.layer__thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid #111111;
  background: repeating-conic-gradient(#8a8a8a 0 25%, #b4b4b4 0 50%) 0 0 / 8px 8px;
  overflow: hidden;
}

.layer__thumb img {
  max-width: 100%;
  max-height: 100%;
}

.layer__thumb--mask {
  filter: grayscale(1);
}

.layer__folder {
  color: #d0d0d0;
  font-size: 13px;
}

.layer__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.layer__rename {
  flex: 1;
  min-width: 0;
  padding: 1px 3px;
  border: 1px solid var(--ps-accent);
  background: var(--ps-well);
  color: var(--ps-text-strong);
}

.layer__badge {
  color: #b8b8b8;
  font-size: 10px;
}

.layer__badge--warn {
  color: #d09060;
}

/* Footer */
.panel__footer {
  display: flex;
  gap: 1px;
  align-items: center;
  padding: 3px 4px;
  background: var(--ps-frame);
  border-top: 1px solid var(--ps-line-hard);
  box-shadow: 0 -1px 0 rgb(255 255 255 / 5%);
}

.panel__footer-gap {
  flex: 1;
}

.icon {
  min-width: 22px;
  height: 20px;
  padding: 0 4px;
  border: 1px solid transparent;
  border-radius: 2px;
  background: none;
  color: #c8c8c8;
  font-size: 11px;
  cursor: pointer;
}

.icon:hover:not(:disabled) {
  background: var(--ps-control);
  border-color: var(--ps-line);
}

.icon:disabled {
  opacity: 0.35;
  cursor: default;
}

.panel__count {
  padding-right: 2px;
  color: var(--ps-text-faint);
  font-size: 10px;
}
</style>
