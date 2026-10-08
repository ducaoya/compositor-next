<script setup lang="ts">
/**
 * The Layer Effects panel.
 *
 * Six effects, each off until it is turned on, and each showing only the settings it has — a
 * stroke has a position, a glow does not. The source of truth is the manifest, so the panel reads
 * and writes the same records the `.comp` file holds.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { EFFECT_ORDER, type EffectKey, type LayerEffects } from '../model/effects'
import {
  beginEdit,
  closeEffectsSheet,
  endEdit,
  patchEffect,
  setEffectEnabled,
  toggleEffect,
  useSession,
} from '../state/session'

const { t } = useI18n()
const { activeLayer, activeLayerEffects, effectsSheetOpen } = useSession()

const effects = computed<LayerEffects | null>(() => activeLayerEffects.value)

function kindLabel(key: EffectKey): string {
  return t(`effects.kind.${key}`)
}

function has(key: EffectKey): boolean {
  return Boolean(effects.value?.[key])
}

function settings(key: EffectKey): Record<string, unknown> {
  return (effects.value?.[key] as Record<string, unknown> | undefined) ?? {}
}

function numberFrom(key: EffectKey, field: string, event: Event): void {
  patchEffect(key, { [field]: Number((event.target as HTMLInputElement).value) })
}

function colorOf(key: EffectKey): string {
  const value = settings(key)
  const part = (channel: string) =>
    Math.round(Math.min(1, Math.max(0, Number(value[channel] ?? 0))) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${part('red')}${part('green')}${part('blue')}`
}

function setColor(key: EffectKey, hex: string): void {
  patchEffect(key, {
    red: Number.parseInt(hex.slice(1, 3), 16) / 255,
    green: Number.parseInt(hex.slice(3, 5), 16) / 255,
    blue: Number.parseInt(hex.slice(5, 7), 16) / 255,
  })
}

/** One gesture: snapshot, change, commit, so a drag is a single undo step. */
function gesture(label: string, body: () => void): void {
  beginEdit(label)
  body()
  endEdit()
}

const SLIDERS: Record<string, { field: string; min: number; max: number; step: number }[]> = {
  stroke: [
    { field: 'size', min: 0, max: 200, step: 1 },
    { field: 'opacity', min: 0, max: 1, step: 0.01 },
  ],
  shadow: [
    { field: 'angle', min: -180, max: 180, step: 1 },
    { field: 'distance', min: 0, max: 300, step: 1 },
    { field: 'blur', min: 0, max: 200, step: 1 },
    { field: 'opacity', min: 0, max: 1, step: 0.01 },
  ],
  colorOverlay: [{ field: 'opacity', min: 0, max: 1, step: 0.01 }],
  innerShadow: [
    { field: 'angle', min: -180, max: 180, step: 1 },
    { field: 'distance', min: 0, max: 300, step: 1 },
    { field: 'blur', min: 0, max: 200, step: 1 },
    { field: 'opacity', min: 0, max: 1, step: 0.01 },
  ],
  outerGlow: [
    { field: 'size', min: 0, max: 200, step: 1 },
    { field: 'opacity', min: 0, max: 1, step: 0.01 },
  ],
  innerGlow: [
    { field: 'size', min: 0, max: 200, step: 1 },
    { field: 'opacity', min: 0, max: 1, step: 0.01 },
  ],
}
</script>

<template>
  <div v-if="effectsSheetOpen" class="scrim" @click.self="closeEffectsSheet">
    <div class="sheet" role="dialog">
      <header class="sheet__head">
        <h2>{{ t('effects.title') }}</h2>
        <button class="sheet__close" @click="closeEffectsSheet">✕</button>
      </header>

      <p v-if="!activeLayer" class="sheet__note">{{ t('properties.empty') }}</p>

      <div v-else class="sheet__body">
        <div v-for="key in EFFECT_ORDER" :key="key" class="effect" :class="{ 'effect--on': has(key) }">
          <label class="effect__head">
            <input
              type="checkbox"
              :checked="has(key)"
              @change="toggleEffect(key)"
            />
            <span class="effect__name">{{ kindLabel(key) }}</span>
            <span v-if="has(key)" class="effect__spacer" />
            <input
              v-if="has(key)"
              class="effect__swatch"
              type="color"
              :value="colorOf(key)"
              @input="gesture('Layer Effects', () => setColor(key, ($event.target as HTMLInputElement).value))"
            />
          </label>

          <div v-if="has(key)" class="effect__body">
            <label
              v-for="slider in SLIDERS[key]"
              :key="slider.field"
              class="slider"
            >
              <span>{{ t(`effects.${slider.field}`) }}</span>
              <input
                type="range"
                :min="slider.min"
                :max="slider.max"
                :step="slider.step"
                :value="settings(key)[slider.field]"
                @pointerdown="beginEdit('Layer Effects')"
                @input="numberFrom(key, slider.field, $event)"
                @change="endEdit()"
                @pointerup="endEdit()"
              />
              <output>{{ Number(settings(key)[slider.field] ?? 0).toFixed(slider.step < 1 ? 2 : 0) }}</output>
            </label>

            <label v-if="key === 'stroke'" class="slider">
              <span>{{ t('effects.position') }}</span>
              <select
                class="effect__select"
                :value="settings(key).inside ? 'inside' : 'outside'"
                @change="
                  gesture('Layer Effects', () =>
                    patchEffect(key, { inside: ($event.target as HTMLSelectElement).value === 'inside' }),
                  )
                "
              >
                <option value="outside">{{ t('effects.outside') }}</option>
                <option value="inside">{{ t('effects.inside') }}</option>
              </select>
            </label>

            <label class="check">
              <input
                type="checkbox"
                :checked="settings(key).enabled !== false"
                @change="setEffectEnabled(key, ($event.target as HTMLInputElement).checked)"
              />
              {{ t('effects.enabled') }}
            </label>
          </div>
        </div>

        <p class="sheet__note">{{ t('effects.note') }}</p>
        <p v-if="!effects || Object.keys(effects).length === 0" class="sheet__note">
          {{ t('effects.empty') }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 45%);
  z-index: 14;
}

.sheet {
  width: 420px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  border: 1px solid #3c3f46;
  border-radius: 8px;
  background: #2b2c31;
  box-shadow: 0 12px 40px rgb(0 0 0 / 45%);
}

.sheet__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid #33353a;
}

.sheet__head h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #e6e8ec;
}

.sheet__close {
  padding: 2px 6px;
  border: 0;
  background: none;
  color: #8d939e;
  font-size: 12px;
  cursor: pointer;
}

.sheet__body {
  padding: 8px 14px 14px;
  overflow: auto;
}

.effect {
  border-bottom: 1px solid #33353a;
  padding: 6px 0;
}

.effect__head {
  display: flex;
  gap: 8px;
  align-items: center;
  cursor: pointer;
}

.effect__name {
  color: var(--ps-text);
}

.effect--on .effect__name {
  color: var(--ps-text-strong);
}

.effect__spacer {
  flex: 1;
}

.effect__swatch {
  width: 26px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--ps-line);
  background: none;
  cursor: pointer;
}

.effect__body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 0 4px 22px;
}

.slider {
  display: grid;
  grid-template-columns: 74px 1fr 38px;
  gap: 6px;
  align-items: center;
  color: var(--ps-text-dim);
}

.slider input[type='range'] {
  width: 100%;
  height: 4px;
  accent-color: #9a9a9a;
}

.slider output {
  color: var(--ps-text);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.effect__select {
  padding: 2px 4px;
  border: 1px solid var(--ps-line);
  border-radius: var(--ps-radius);
  background: var(--ps-well);
  color: var(--ps-text);
}

.check {
  display: flex;
  gap: 6px;
  align-items: center;
  color: var(--ps-text-dim);
}

.sheet__note {
  margin: 10px 0 0;
  color: var(--ps-text-faint);
  font-size: 10px;
  line-height: 1.5;
}
</style>
