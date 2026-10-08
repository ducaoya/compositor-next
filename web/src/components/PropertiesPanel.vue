<script setup lang="ts">
/**
 * The properties of the active layer: how it composites, and where it sits.
 *
 * A slider drag is one undo step, not one per input event, which is why the value changes go
 * through `beginEdit`/`applyEdit`/`endEdit` rather than the plain mutators.
 */
import { computed } from 'vue'

import { BLEND_MODE_GROUPS, isFolder, type BlendModeName } from '../model/types'
import { applyEdit, beginEdit, endEdit, useSession } from '../state/session'

const { manifest, activeLayer } = useSession()

const folderSelected = computed(() => (activeLayer.value ? isFolder(activeLayer.value) : false))
const hasPixels = computed(() => Boolean(activeLayer.value?.imageFile))

/** The layer the base for a clipping mask would be: the sibling directly below. */
const clippingBase = computed(() => {
  const layer = activeLayer.value
  const current = manifest.value
  if (!layer || !current) return null
  const parent = layer.parentID ?? null
  const siblings = current.layers.filter((record) => (record.parentID ?? null) === parent)
  const index = siblings.findIndex((record) => record.id === layer.id)
  if (index <= 0) return null
  const below = siblings[index - 1]
  if (isFolder(layer) || isFolder(below) || below.adjustment !== undefined) return null
  return below
})

const clippingSource = computed(() => activeLayer.value?.maskSourceID ?? null)

function setOpacity(value: number): void {
  applyEdit((current) => {
    const layer = current.layers.find((record) => record.id === activeLayer.value?.id)
    if (layer) layer.opacity = value
  })
}

function setNumber(field: 'x' | 'y' | 'width' | 'height' | 'rotation', value: number): void {
  applyEdit((current) => {
    const layer = current.layers.find((record) => record.id === activeLayer.value?.id)
    if (!layer || !Number.isFinite(value)) return
    const transform = layer.transform
    if (field === 'x') transform.origin[0] = value
    if (field === 'y') transform.origin[1] = value
    if (field === 'width') transform.size[0] = Math.max(1, value)
    if (field === 'height') transform.size[1] = Math.max(1, value)
    if (field === 'rotation') transform.rotation = value
  })
}

function setSampling(value: string): void {
  const current = manifest.value
  const layer = activeLayer.value
  if (!current || !layer) return
  edit('Sampling', () => {
    layer.transform.sampling = value as typeof layer.transform.sampling
  })
}

function setBlend(value: string): void {
  const layer = activeLayer.value
  if (!layer) return
  edit('Blend Mode', () => {
    layer.blendMode = value as BlendModeName
  })
}

function toggleMaskEnabled(): void {
  const layer = activeLayer.value
  if (!layer) return
  edit('Mask', () => {
    layer.maskEnabled = layer.maskEnabled === false
  })
}

function toggleClipping(): void {
  const layer = activeLayer.value
  if (!layer) return
  edit('Clipping Mask', () => {
    if (layer.maskSourceID) delete layer.maskSourceID
    else if (clippingBase.value) layer.maskSourceID = clippingBase.value.id
  })
}

function toggleFlip(axis: 'flipX' | 'flipY'): void {
  const layer = activeLayer.value
  if (!layer) return
  edit('Flip', () => {
    layer.transform[axis] = !layer.transform[axis]
  })
}

function edit(label: string, body: () => void): void {
  beginEdit(label)
  body()
  endEdit()
}
</script>

<template>
  <section class="properties">
    <header class="properties__head">
      <h2>Properties</h2>
    </header>

    <p v-if="!activeLayer" class="properties__empty">Select a layer to see its properties.</p>

    <div v-else class="properties__body">
      <label class="field">
        <span class="field__label">Name</span>
        <input
          class="field__input"
          :value="activeLayer.name"
          @change="edit('Rename Layer', () => (activeLayer!.name = ($event.target as HTMLInputElement).value))"
        />
      </label>

      <label class="field">
        <span class="field__label">Blend</span>
        <select
          class="field__input"
          :value="activeLayer.blendMode ?? 'Normal'"
          :disabled="folderSelected"
          @change="setBlend(($event.target as HTMLSelectElement).value)"
        >
          <optgroup v-for="(group, index) in BLEND_MODE_GROUPS" :key="index" :label="`Group ${index + 1}`">
            <option v-for="mode in group" :key="mode" :value="mode">{{ mode }}</option>
          </optgroup>
        </select>
      </label>

      <label class="field">
        <span class="field__label">Opacity</span>
        <div class="field__row">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="activeLayer.opacity ?? 1"
            @pointerdown="beginEdit('Opacity')"
            @input="setOpacity(Number(($event.target as HTMLInputElement).value))"
            @change="endEdit()"
            @pointerup="endEdit()"
          />
          <span class="field__value">{{ Math.round((activeLayer.opacity ?? 1) * 100) }}%</span>
        </div>
      </label>

      <div class="properties__grid">
        <label class="field field--tiny">
          <span class="field__label">X</span>
          <input
            type="number"
            class="field__input"
            :value="activeLayer.transform.origin[0]"
            @change="edit('Position', () => setNumber('x', Number(($event.target as HTMLInputElement).value)))"
          />
        </label>
        <label class="field field--tiny">
          <span class="field__label">Y</span>
          <input
            type="number"
            class="field__input"
            :value="activeLayer.transform.origin[1]"
            @change="edit('Position', () => setNumber('y', Number(($event.target as HTMLInputElement).value)))"
          />
        </label>
        <label class="field field--tiny">
          <span class="field__label">W</span>
          <input
            type="number"
            class="field__input"
            :value="Math.round(activeLayer.transform.size[0])"
            @change="edit('Size', () => setNumber('width', Number(($event.target as HTMLInputElement).value)))"
          />
        </label>
        <label class="field field--tiny">
          <span class="field__label">H</span>
          <input
            type="number"
            class="field__input"
            :value="Math.round(activeLayer.transform.size[1])"
            @change="edit('Size', () => setNumber('height', Number(($event.target as HTMLInputElement).value)))"
          />
        </label>
        <label class="field field--tiny">
          <span class="field__label">Angle</span>
          <input
            type="number"
            class="field__input"
            :value="Math.round(activeLayer.transform.rotation)"
            @change="edit('Rotate', () => setNumber('rotation', Number(($event.target as HTMLInputElement).value)))"
          />
        </label>
        <label class="field field--tiny">
          <span class="field__label">Sampling</span>
          <select
            class="field__input"
            :value="activeLayer.transform.sampling"
            @change="setSampling(($event.target as HTMLSelectElement).value)"
          >
            <option value="High quality">High quality</option>
            <option value="Smooth">Smooth</option>
            <option value="Nearest">Nearest</option>
          </select>
        </label>
      </div>

      <div class="properties__actions">
        <button class="chip" @click="toggleFlip('flipX')">Flip H</button>
        <button class="chip" @click="toggleFlip('flipY')">Flip V</button>
      </div>

      <div class="properties__actions">
        <button
          class="chip"
          :disabled="!clippingBase && !clippingSource"
          :title="clippingBase ? `Clip to “${clippingBase.name}”` : 'The bottom layer has nothing to clip to'"
          @click="toggleClipping"
        >
          {{ clippingSource ? 'Release Clipping Mask' : 'Create Clipping Mask' }}
        </button>
        <button v-if="activeLayer.maskFile" class="chip" @click="toggleMaskEnabled">
          {{ activeLayer.maskEnabled === false ? 'Enable Mask' : 'Disable Mask' }}
        </button>
      </div>

      <div class="properties__facts">
        <p v-if="activeLayer.maskSourceID">Clipped to the layer below.</p>
        <p v-if="activeLayer.adjustment !== undefined">
          This is an adjustment layer. The file keeps its settings; this build does not render them
          yet.
        </p>
        <p v-if="!hasPixels && !folderSelected">This layer has no pixels yet.</p>
        <p v-if="folderSelected">A folder composites what is inside it, so its blend mode stays Normal.</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.properties {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #26272b;
  border-top: 1px solid #33353a;
}

.properties__head {
  padding: 8px 10px;
  border-bottom: 1px solid #33353a;
}

.properties__head h2 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #8d939e;
}

.properties__empty {
  margin: 0;
  padding: 14px 10px;
  color: #6f7580;
  font-size: 12px;
}

.properties__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  overflow: auto;
}

.properties__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.properties__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.properties__facts p {
  margin: 2px 0;
  font-size: 11px;
  color: #7d838d;
  line-height: 1.5;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.field__label {
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #7d838d;
}

.field__row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.field__value {
  width: 44px;
  text-align: right;
  font-size: 11px;
  color: #9aa0ab;
  font-variant-numeric: tabular-nums;
}

.field__input {
  width: 100%;
  min-width: 0;
  padding: 3px 5px;
  border: 1px solid #3c3f46;
  border-radius: 3px;
  background: #1c1d21;
  color: #d6d9df;
  font: inherit;
  font-size: 12px;
}

.field__input:disabled {
  opacity: 0.45;
}

input[type='range'] {
  flex: 1;
  min-width: 0;
  accent-color: #4c9aff;
}

.chip {
  padding: 3px 8px;
  border: 1px solid #3c3f46;
  border-radius: 3px;
  background: #2e3036;
  color: #c8ccd3;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.chip:hover:not(:disabled) {
  background: #383b42;
}

.chip:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
