<script setup lang="ts">
/**
 * The Properties panel: how the active layer composites, and where it sits.
 *
 * A slider drag is one undo step, not one per input event, which is why the value changes go
 * through `beginEdit`/`applyEdit`/`endEdit` rather than the plain mutators.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import AdjustmentPanel from './AdjustmentPanel.vue'
import { SAMPLINGS, isFolder, samplingKey } from '../model/types'
import { applyEdit, beginEdit, endEdit, useSession } from '../state/session'

const { t } = useI18n()
const { manifest, activeLayer, limits, activeAdjustment } = useSession()

const folderSelected = computed(() => (activeLayer.value ? isFolder(activeLayer.value) : false))

/** The layer a clipping mask would clip to: the sibling directly below. */
const clippingBase = computed(() => {
  const layer = activeLayer.value
  const current = manifest.value
  if (!layer || !current || isFolder(layer)) return null
  const parent = layer.parentID ?? null
  const siblings = current.layers.filter((record) => (record.parentID ?? null) === parent)
  const at = siblings.findIndex((record) => record.id === layer.id)
  if (at <= 0) return null
  const below = siblings[at - 1]
  return isFolder(below) || below.adjustment !== undefined ? null : below
})

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

function scrub(label: string, body: () => void): void {
  beginEdit(label)
  body()
  endEdit()
}

const pixelSize = computed(() => {
  const layer = activeLayer.value
  if (!layer) return { width: 0, height: 0 }
  const asset = manifest.value?.layers.find((record) => record.id === layer.id)
  void asset
  return { width: Math.round(layer.transform.size[0]), height: Math.round(layer.transform.size[1]) }
})
</script>

<template>
  <section class="panel">
    <header class="panel__tabs">
      <button class="panel__tab panel__tab--on">{{ t('properties.title') }}</button>
      <button class="panel__tab" disabled>{{ t('properties.history') }}</button>
    </header>

    <p v-if="!activeLayer" class="panel__empty">{{ t('properties.empty') }}</p>

    <div v-else class="panel__body">
      <div class="group">
        <div class="group__title">
          {{ folderSelected ? t('properties.group') : t('properties.layer') }}
        </div>
        <label class="field">
          <span class="field__label">{{ t('properties.name') }}</span>
          <input
            class="field__input"
            :value="activeLayer.name"
            @change="
              scrub('Rename Layer', () => (activeLayer!.name = ($event.target as HTMLInputElement).value))
            "
          />
        </label>
      </div>

      <div v-if="activeAdjustment" class="group">
        <div class="group__title">{{ t('adjust.title') }}</div>
        <AdjustmentPanel />
      </div>

      <div v-if="!folderSelected && !activeAdjustment" class="group">
        <div class="group__title">{{ t('properties.transform') }}</div>
        <div class="grid">
          <label class="field field--number">
            <span class="field__letter">X</span>
            <input
              type="number"
              class="field__input"
              :value="Math.round(activeLayer.transform.origin[0])"
              @change="scrub('Position', () => setNumber('x', Number(($event.target as HTMLInputElement).value)))"
            />
          </label>
          <label class="field field--number">
            <span class="field__letter">Y</span>
            <input
              type="number"
              class="field__input"
              :value="Math.round(activeLayer.transform.origin[1])"
              @change="scrub('Position', () => setNumber('y', Number(($event.target as HTMLInputElement).value)))"
            />
          </label>
          <label class="field field--number">
            <span class="field__letter">W</span>
            <input
              type="number"
              class="field__input"
              :value="pixelSize.width"
              @change="scrub('Size', () => setNumber('width', Number(($event.target as HTMLInputElement).value)))"
            />
          </label>
          <label class="field field--number">
            <span class="field__letter">H</span>
            <input
              type="number"
              class="field__input"
              :value="pixelSize.height"
              @change="scrub('Size', () => setNumber('height', Number(($event.target as HTMLInputElement).value)))"
            />
          </label>
          <label class="field field--number">
            <span class="field__letter">∠</span>
            <input
              type="number"
              class="field__input"
              :value="Math.round(activeLayer.transform.rotation * 100) / 100"
              @change="scrub('Rotate', () => setNumber('rotation', Number(($event.target as HTMLInputElement).value)))"
            />
          </label>
          <label class="field field--number">
            <span class="field__letter">◱</span>
            <select
              class="field__input"
              :value="activeLayer.transform.sampling"
              @change="
                scrub('Sampling', () => {
                  const value = ($event.target as HTMLSelectElement).value
                  activeLayer!.transform.sampling = value as typeof activeLayer.transform.sampling
                })
              "
            >
              <option v-for="name in SAMPLINGS" :key="name" :value="name">
                {{ t(samplingKey(name)) }}
              </option>
            </select>
          </label>
        </div>
        <div class="buttons">
          <button
            class="chip"
            @click="scrub('Flip Horizontal', () => (activeLayer!.transform.flipX = !activeLayer!.transform.flipX))"
          >
            {{ t('properties.flipH') }}
          </button>
          <button
            class="chip"
            @click="scrub('Flip Vertical', () => (activeLayer!.transform.flipY = !activeLayer!.transform.flipY))"
          >
            {{ t('properties.flipV') }}
          </button>
          <button class="chip" @click="scrub('Reset Rotation', () => (activeLayer!.transform.rotation = 0))">
            {{ t('properties.resetRotation') }}
          </button>
        </div>
      </div>

      <div v-if="!folderSelected" class="group">
        <div class="group__title">{{ t('properties.masks') }}</div>
        <div class="buttons">
          <button
            class="chip"
            :disabled="!clippingBase && !activeLayer.maskSourceID"
            :title="
              clippingBase
                ? t('properties.clipTo', { name: clippingBase.name })
                : t('properties.nothingToClip')
            "
            @click="
              scrub(activeLayer.maskSourceID ? 'Release Clipping Mask' : 'Create Clipping Mask', () => {
                if (activeLayer!.maskSourceID) delete activeLayer!.maskSourceID
                else if (clippingBase) activeLayer!.maskSourceID = clippingBase.id
              })
            "
          >
            {{
              activeLayer.maskSourceID
                ? t('properties.releaseClippingMask')
                : t('properties.createClippingMask')
            }}
          </button>
          <button
            v-if="activeLayer.maskFile"
            class="chip"
            @click="scrub('Mask', () => (activeLayer!.maskEnabled = activeLayer!.maskEnabled === false))"
          >
            {{ activeLayer.maskEnabled === false ? t('properties.enableMask') : t('properties.disableMask') }}
          </button>
        </div>
        <p v-if="activeLayer.maskSourceID" class="panel__note">{{ t('properties.clippedToBelow') }}</p>
        <p v-else-if="!activeLayer.maskFile" class="panel__note">
          {{ t('properties.masksReadOnly') }}
        </p>
      </div>

      <p v-if="activeLayer.adjustment !== undefined" class="panel__note">
        {{ t('properties.adjustmentNote') }}
      </p>
      <p v-else-if="!activeLayer.imageFile && !folderSelected" class="panel__note">
        {{ t('properties.noPixelsNote') }}
      </p>
      <p v-if="folderSelected" class="panel__note">
        {{ t('properties.folderNote') }}
      </p>
      <p v-if="manifest" class="panel__note">
        {{
          t('properties.canvasNote', {
            width: manifest.width,
            height: manifest.height,
            maxSide: limits.maxSide.toLocaleString(),
          })
        }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--ps-panel);
  border-top: 1px solid var(--ps-line-hard);
}

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

.panel__empty {
  margin: 0;
  padding: 12px 8px;
  color: var(--ps-text-dim);
}

.panel__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 320px;
  padding: 8px;
  overflow: auto;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.group__title {
  color: var(--ps-text-faint);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 6px;
}

.field {
  display: flex;
  gap: 5px;
  align-items: center;
  min-width: 0;
}

.field__label {
  width: 40px;
  color: var(--ps-text-dim);
}

.field__letter {
  width: 12px;
  color: var(--ps-text-dim);
  text-align: center;
}

.field__input {
  flex: 1;
  min-width: 0;
  padding: 2px 4px;
  border: 1px solid var(--ps-line);
  border-radius: var(--ps-radius);
  background: var(--ps-well);
  color: var(--ps-text);
}

.field__input:focus {
  border-color: var(--ps-accent);
  outline: none;
}

.buttons {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.chip {
  padding: 2px 7px;
  border: 1px solid var(--ps-line);
  border-radius: var(--ps-radius);
  background: var(--ps-control);
  color: var(--ps-text);
  font-size: 11px;
  cursor: pointer;
}

.chip:hover:not(:disabled) {
  background: var(--ps-control-hover);
}

.chip:disabled {
  opacity: 0.4;
  cursor: default;
}

.panel__note {
  margin: 0;
  color: var(--ps-text-faint);
  font-size: 10px;
  line-height: 1.5;
}
</style>
