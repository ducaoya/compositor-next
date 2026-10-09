<script setup lang="ts">
/**
 * One dialog for the whole-layer filters.
 *
 * The filters differ only in which numbers they take, so they share a sheet and a set of controls
 * rather than each getting a component of their own. Every filter is applied once, on OK, and is one
 * undo step: Photoshop previews a filter live, but the preview is a second rendering path, and this
 * build would rather apply the real thing than show something close to it.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { applyFilter, closeFilterSheet, filterSheet, filterSettings, useSession } from '../state/session'
import type { FilterKind } from '../state/session'

const { t } = useI18n()
const { selection } = useSession()

/** One number the open filter takes: a key of its settings, a range, and whether it is a percent. */
interface Field {
  key: string
  min: number
  max: number
  step: number
  suffix?: string
}

const FIELDS: Record<FilterKind, Field[]> = {
  vignette: [
    { key: 'amount', min: -100, max: 100, step: 1 },
    { key: 'midpoint', min: 0, max: 100, step: 1, suffix: '%' },
    { key: 'roundness', min: -100, max: 100, step: 1 },
    { key: 'feather', min: 0, max: 100, step: 1, suffix: '%' },
    { key: 'highlights', min: 0, max: 100, step: 1, suffix: '%' },
  ],
  glow: [
    { key: 'radius', min: 1, max: 200, step: 1, suffix: 'px' },
    { key: 'amount', min: 0, max: 100, step: 1, suffix: '%' },
  ],
  tonal: [
    { key: 'radius', min: 1, max: 200, step: 1, suffix: 'px' },
    { key: 'amount', min: 0, max: 100, step: 1, suffix: '%' },
    { key: 'shadows', min: -100, max: 100, step: 1 },
    { key: 'midtones', min: -100, max: 100, step: 1 },
    { key: 'highlights', min: -100, max: 100, step: 1 },
  ],
  lens: [{ key: 'distortion', min: -100, max: 100, step: 1 }],
  noise: [
    { key: 'amount', min: 0, max: 400, step: 1, suffix: '%' },
  ],
  blur: [{ key: 'radius', min: 0.1, max: 250, step: 0.1, suffix: 'px' }],
}

const kind = computed(() => filterSheet.value)
const title = computed(() => (kind.value ? t(`filters.${kind.value}`) : ''))
const note = computed(() => (kind.value ? t(`filters.${kind.value}Note`) : ''))
const fields = computed(() => (kind.value ? FIELDS[kind.value] : []))

/**
 * The open filter's settings block, as a plain record.
 *
 * The sheet writes straight through to the reactive object, which is what makes Photoshop's
 * behaviour of remembering the last settings fall out rather than needing to be stored: the numbers
 * are the state, and they are shared with the next time the sheet opens.
 */
function block(): Record<string, number | boolean> {
  const current = kind.value
  if (!current) return {}
  return filterSettings[current] as unknown as Record<string, number | boolean>
}

function onChecked(key: string, event: Event): void {
  block()[key] = (event.target as HTMLInputElement).checked
}

function apply(): void {
  const current = kind.value
  if (!current) return
  closeFilterSheet()
  applyFilter(current)
}
</script>

<template>
  <div v-if="kind" class="scrim" @click.self="closeFilterSheet">
    <div class="sheet" role="dialog">
      <h2 class="sheet__title">{{ title }}</h2>
      <p class="sheet__hint">{{ note }}</p>

      <div class="sheet__fields">
        <label v-for="field in fields" :key="field.key" class="sheet__field">
          <span>{{ t(`filters.${field.key}`) }}</span>
          <input
            v-model.number="(block() as Record<string, number>)[field.key]"
            type="range"
            :min="field.min"
            :max="field.max"
            :step="field.step"
          />
          <output>{{ (block() as Record<string, number>)[field.key] }}{{ field.suffix ?? '' }}</output>
        </label>

        <label v-if="kind === 'vignette'" class="sheet__check">
          <input type="checkbox" :checked="filterSettings.vignette.amount >= 0" @change="filterSettings.vignette.amount = -filterSettings.vignette.amount" />
          {{ t('filters.lightenCorners') }}
        </label>
        <label v-if="kind === 'noise'" class="sheet__check">
          <input type="checkbox" :checked="filterSettings.noise.gaussian" @change="onChecked('gaussian', $event)" />
          {{ t('filters.gaussianNoise') }}
        </label>
        <label v-if="kind === 'noise'" class="sheet__check">
          <input type="checkbox" :checked="filterSettings.noise.monochromatic" @change="onChecked('monochromatic', $event)" />
          {{ t('adjust.monochromatic') }}
        </label>
      </div>

      <p v-if="!selection" class="sheet__hint">{{ t('filters.wholeLayer') }}</p>

      <div class="sheet__actions">
        <button class="sheet__button" @click="closeFilterSheet">{{ t('common.cancel') }}</button>
        <button class="sheet__button sheet__button--primary" @click="apply">{{ t('common.ok') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The sheet chrome is DimensionSheet's, repeated because a scoped style does not travel. */
.scrim {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 45%);
  z-index: 12;
}

.sheet {
  width: 360px;
  padding: 16px;
  border: 1px solid #3c3f46;
  border-radius: 8px;
  background: #2b2c31;
  box-shadow: 0 12px 40px rgb(0 0 0 / 45%);
}

.sheet__title {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: #e6e8ec;
}

.sheet__hint {
  margin: 8px 0 0;
  font-size: 11px;
  color: #6f7580;
  line-height: 1.5;
}

.sheet__fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.sheet__field {
  display: grid;
  grid-template-columns: 74px 1fr 62px;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  color: #9aa1ab;
}

.sheet__field input[type='range'] {
  width: 100%;
  height: 4px;
  accent-color: #9a9a9a;
}

.sheet__field output {
  color: #d6d9df;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.sheet__check {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 11px;
  color: #9aa1ab;
}

.sheet__actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 16px;
}

.sheet__button {
  padding: 5px 12px;
  border: 1px solid #3c3f46;
  border-radius: 4px;
  background: #33353b;
  color: #d6d9df;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sheet__button:hover {
  background: #3d4047;
}

.sheet__button--primary {
  background: #3f6ea8;
  border-color: #4b7fbe;
}

.sheet__button--primary:hover {
  background: #4879b6;
}
</style>
