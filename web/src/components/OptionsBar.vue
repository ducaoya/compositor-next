<script setup lang="ts">
/**
 * The options bar, which Photoshop puts under the menu: the settings for whichever tool is
 * selected, and nothing else.
 *
 * Controls with no behaviour behind them in this build are dimmed rather than hidden, so the bar
 * reads as the tool's options rather than as a different bar per tool.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { TOOLS_BY_ID } from '../model/tools'
import { fit, importImages, useSession, zoomTo } from '../state/session'

const { t } = useI18n()
const { tool, brush, foreground, selection, wandTolerance, wandContiguous } = useSession()

const label = computed(() => {
  const definition = TOOLS_BY_ID.get(tool.value)
  return definition ? t(definition.labelKey) : ''
})

/** A round stroke of the current tip, drawn the way the brush preview in Photoshop shows it. */
const tipStyle = computed(() => {
  const diameter = Math.max(4, Math.min(26, brush.size / 3))
  const inner = Math.round(diameter * brush.hardness)
  return {
    width: `${diameter}px`,
    height: `${diameter}px`,
    background: `radial-gradient(circle, rgb(${foreground.r},${foreground.g},${foreground.b}) 0 ${inner}px, transparent ${diameter}px)`,
  }
})

const isBrush = computed(() => tool.value === 'brush' || tool.value === 'eraser')
const isMarquee = computed(
  () => tool.value === 'marqueeRect' || tool.value === 'marqueeEllipse' || tool.value === 'lasso',
)
const isZoomLike = computed(() => tool.value === 'zoom' || tool.value === 'hand')
</script>

<template>
  <div class="options">
    <span class="options__tool">{{ label }}</span>

    <!-- Move -->
    <template v-if="tool === 'move'">
      <label class="options__check"><input type="checkbox" disabled /> {{ t('options.autoSelect') }}</label>
      <label class="options__select">
        <select disabled><option>{{ t('options.layer') }}</option></select>
      </label>
      <label class="options__check"><input type="checkbox" disabled /> {{ t('options.showTransformControls') }}</label>
    </template>

    <!-- Marquee -->
    <template v-else-if="isMarquee">
      <div class="options__modes">
        <button class="options__mode" :class="{ 'options__mode--on': true }" :title="t('options.newSelection')">▢</button>
        <button class="options__mode" disabled :title="t('options.addSelection')">▢</button>
        <button class="options__mode" disabled :title="t('options.subtractSelection')">▢</button>
        <button class="options__mode" disabled :title="t('options.intersectSelection')">▢</button>
      </div>
      <label class="options__number">
        {{ t('options.feather') }} <input type="number" value="0" disabled /> {{ t('common.px') }}
      </label>
      <label class="options__select" :title="t('options.normalHint')">
        {{ t('options.style') }} <select disabled><option>{{ t('options.styleNormal') }}</option></select>
      </label>
      <button class="options__button" :disabled="!selection">
        {{ selection ? t('options.selectionActive') : t('options.noSelection') }}
      </button>
    </template>

    <!-- Brush and Eraser -->
    <template v-else-if="isBrush">
      <div class="options__tip" :title="t('options.brushTip', { size: Math.round(brush.size) })">
        <span class="options__tip-dot" :style="tipStyle" />
      </div>
      <label class="options__number">
        {{ t('options.size') }} <input v-model.number="brush.size" type="number" min="1" max="500" step="1" />
        {{ t('common.px') }}
      </label>
      <label class="options__number">
        {{ t('options.hardness') }} <input v-model.number="brush.hardness" type="number" min="0" max="1" step="0.01" />
      </label>
      <label class="options__number">
        {{ t('options.opacity') }} <input v-model.number="brush.opacity" type="number" min="0" max="1" step="0.01" />
      </label>
      <label class="options__number">
        {{ t('options.flow') }} <input v-model.number="brush.flow" type="number" min="0" max="1" step="0.01" />
      </label>
    </template>

    <!-- Magic Wand -->
    <template v-else-if="tool === 'wand'">
      <label class="options__number">
        {{ t('options.tolerance') }} <input v-model.number="wandTolerance" type="number" min="0" max="255" />
      </label>
      <label class="options__check">
        <input v-model="wandContiguous" type="checkbox" /> {{ t('options.contiguous') }}
      </label>
      <label class="options__select">
        <select disabled><option>{{ t('options.sampleAllLayers') }}</option></select>
      </label>
    </template>

    <!-- Eyedropper -->
    <template v-else-if="tool === 'eyedropper'">
      <label class="options__select" :title="t('options.pointSampleHint')">
        {{ t('options.sampleSize') }}
        <select disabled><option>{{ t('options.pointSample') }}</option></select>
      </label>
    </template>

    <!-- Zoom and Hand -->
    <template v-else-if="isZoomLike">
      <button v-if="tool === 'zoom'" class="options__button" @click="zoomTo(1)">100%</button>
      <button class="options__button" @click="fit">{{ t('options.fitOnScreen') }}</button>
    </template>

    <span class="options__spacer" />
    <button class="options__button" @click="importImages">{{ t('options.import') }}</button>
  </div>
</template>

<style scoped>
.options {
  display: flex;
  gap: 12px;
  align-items: center;
  height: 28px;
  padding: 0 8px;
  background: var(--ps-frame);
  border-bottom: 1px solid var(--ps-line-hard);
  box-shadow: 0 1px 0 rgb(255 255 255 / 5%);
  font-size: 11px;
  color: var(--ps-text);
  overflow: hidden;
  white-space: nowrap;
}

.options__tool {
  min-width: 92px;
  font-weight: 600;
  color: var(--ps-text-strong);
}

.options__spacer {
  flex: 1;
}

.options__check {
  display: flex;
  gap: 4px;
  align-items: center;
  color: var(--ps-text-dim);
}

.options__number {
  display: flex;
  gap: 4px;
  align-items: center;
  color: var(--ps-text-dim);
}

.options__number input {
  width: 52px;
  padding: 2px 4px;
  border: 1px solid var(--ps-line);
  border-radius: var(--ps-radius);
  background: var(--ps-well);
  color: var(--ps-text);
  text-align: right;
}

.options__select {
  display: flex;
  gap: 4px;
  align-items: center;
  color: var(--ps-text-dim);
}

.options__select select {
  padding: 2px 4px;
  border: 1px solid var(--ps-line);
  border-radius: var(--ps-radius);
  background: var(--ps-control);
  color: var(--ps-text);
  font-size: 11px;
}

.options__select select:disabled {
  opacity: 0.5;
}

.options__modes {
  display: flex;
}

.options__mode {
  width: 22px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--ps-line);
  background: var(--ps-control);
  color: var(--ps-text);
  cursor: pointer;
}

.options__mode:first-child {
  border-radius: var(--ps-radius) 0 0 var(--ps-radius);
}

.options__mode:last-child {
  border-radius: 0 var(--ps-radius) var(--ps-radius) 0;
  border-left: 0;
}

.options__mode--on {
  background: var(--ps-control-active);
  box-shadow: inset 0 1px 3px rgb(0 0 0 / 40%);
}

.options__mode:disabled {
  opacity: 0.4;
}

.options__button {
  padding: 2px 8px;
  border: 1px solid var(--ps-line);
  border-radius: var(--ps-radius);
  background: var(--ps-control);
  color: var(--ps-text);
  font-size: 11px;
  cursor: pointer;
}

.options__button:hover:not(:disabled) {
  background: var(--ps-control-hover);
}

.options__button:disabled {
  opacity: 0.45;
}

.options__tip {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 22px;
  border: 1px solid var(--ps-line);
  border-radius: var(--ps-radius);
  background: var(--ps-well);
}

.options__tip-dot {
  display: block;
  border-radius: 50%;
}
</style>
