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
import { fit, importImages, isLiquifyTool, isRetouchTool, useSession, zoomTo } from '../state/session'

const { t } = useI18n()
const {
  tool,
  brush,
  foreground,
  selection,
  wandTolerance,
  wandContiguous,
  selectionMode,
  gradient,
  shape,
  lassoPolygonal,
  retouch,
  liquifySettings,
  LIQUIFY_MODES,
} = useSession()

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
/** Spot Healing, Clone Stamp, and the smooth and tone groups: they share the tip and little else. */
const isRetouch = computed(() => isRetouchTool())
/** Liquify shares the tip and takes a mode, which is the whole of what it has to say. */
const isLiquify = computed(() => isLiquifyTool())
const isSmooth = computed(() => tool.value === 'blur' || tool.value === 'sharpen' || tool.value === 'smudge')
const isTone = computed(() => tool.value === 'dodge' || tool.value === 'burn' || tool.value === 'sponge')
/** The tones a dodge or burn brush reaches, which is Photoshop's Range menu. */
const TONE_RANGES = ['shadows', 'midtones', 'highlights'] as const
const HEAL_MODES = [
  { id: 0 as const, key: 'options.healContentAware' },
  { id: 1 as const, key: 'options.healCreateTexture' },
  { id: 2 as const, key: 'options.healProximity' },
]
const isMarquee = computed(
  () => tool.value === 'marqueeRect' || tool.value === 'marqueeEllipse' || tool.value === 'lasso',
)
const isZoomLike = computed(() => tool.value === 'zoom' || tool.value === 'hand')

const MODES = [
  { id: 'new' as const, key: 'options.modeNew', glyph: '▢' },
  { id: 'add' as const, key: 'options.modeAdd', glyph: '▣' },
  { id: 'subtract' as const, key: 'options.modeSubtract', glyph: '▤' },
  { id: 'intersect' as const, key: 'options.modeIntersect', glyph: '▥' },
]
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
        <button
          v-for="entry in MODES"
          :key="entry.id"
          class="options__mode"
          :class="{ 'options__mode--on': selectionMode === entry.id }"
          :title="t(entry.key)"
          @click="selectionMode = entry.id"
        >
          {{ entry.glyph }}
        </button>
      </div>
      <label v-if="tool === 'lasso'" class="options__select">
        <select v-model="lassoPolygonal">
          <option :value="false">{{ t('lasso.freehand') }}</option>
          <option :value="true">{{ t('lasso.polygonal') }}</option>
        </select>
      </label>
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

    <!--
      Spot Healing, Clone Stamp, and the smooth and tone groups. They share the tip with the brush,
      because Photoshop's retouch tools do, and then each family gets what is particular to it.
      Photoshop shows Strength instead of Opacity and Flow for these, and so does this.
    -->
    <template v-else-if="isRetouch">
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

      <!-- Clone Stamp -->
      <template v-if="tool === 'clone'">
        <span class="options__hint">{{ t('options.cloneSourceHint') }}</span>
        <label class="options__check">
          <input v-model="retouch.cloneAligned" type="checkbox" /> {{ t('options.aligned') }}
        </label>
      </template>

      <!-- Blur, Sharpen and Smudge -->
      <template v-else-if="isSmooth">
        <label class="options__number">
          {{ t('options.strength') }}
          <input v-model.number="brush.opacity" type="number" min="0" max="1" step="0.01" />
        </label>
        <label class="options__number">
          {{ t('options.blurRadius') }}
          <input v-model.number="retouch.blurRadius" type="number" min="1" max="100" step="1" /> {{ t('common.px') }}
        </label>
      </template>

      <!-- Dodge, Burn and Sponge -->
      <template v-else-if="isTone">
        <label v-if="tool === 'sponge'" class="options__select">
          {{ t('options.mode') }}
          <select v-model="retouch.saturating">
            <option :value="true">{{ t('options.saturate') }}</option>
            <option :value="false">{{ t('options.desaturate') }}</option>
          </select>
        </label>
        <label v-else class="options__select">
          {{ t('options.range') }}
          <select v-model="retouch.toneRange">
            <option v-for="range in TONE_RANGES" :key="range" :value="range">
              {{ t(`options.toneRange.${range}`) }}
            </option>
          </select>
        </label>
        <label class="options__number">
          {{ t('options.exposure') }}
          <input v-model.number="retouch.exposure" type="number" min="1" max="100" step="1" /> %
        </label>
      </template>

      <!-- Spot Healing -->
      <template v-else>
        <label class="options__select">
          {{ t('options.mode') }}
          <select v-model.number="retouch.healMode">
            <option v-for="mode in HEAL_MODES" :key="mode.id" :value="mode.id">{{ t(mode.key) }}</option>
          </select>
        </label>
        <label class="options__number">
          {{ t('options.strength') }}
          <input v-model.number="brush.opacity" type="number" min="0" max="1" step="0.01" />
        </label>
      </template>
    </template>

    <!-- Liquify: the tip, which of the six things it does, and how hard it pulls. -->
    <template v-else-if="isLiquify">
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
      <label class="options__select">
        {{ t('options.mode') }}
        <select v-model="liquifySettings.mode">
          <option v-for="mode in LIQUIFY_MODES" :key="mode" :value="mode">{{ t(`liquify.${mode}`) }}</option>
        </select>
      </label>
      <label class="options__number">
        {{ t('options.pressure') }}
        <input v-model.number="liquifySettings.pressure" type="number" min="1" max="100" step="1" /> %
      </label>
      <span class="options__hint">{{ t('options.liquifyHint') }}</span>
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

    <!-- Gradient -->
    <template v-else-if="tool === 'gradient'">
      <label class="options__select">
        {{ t('options.gradientKind') }}
        <select v-model="gradient.kind">
          <option value="linear">{{ t('options.gradientLinear') }}</option>
          <option value="radial">{{ t('options.gradientRadial') }}</option>
        </select>
      </label>
      <label class="options__check"><input v-model="gradient.reverse" type="checkbox" /> {{ t('options.reverse') }}</label>
      <label class="options__number">
        {{ t('options.opacity') }} <input v-model.number="gradient.opacity" type="number" min="0" max="1" step="0.05" />
      </label>
    </template>

    <!-- Shape -->
    <template v-else-if="tool === 'shape'">
      <label class="options__select">
        {{ t('options.shapeKind') }}
        <select v-model="shape.kind">
          <option value="rectangle">{{ t('options.shapeRectangle') }}</option>
          <option value="ellipse">{{ t('options.shapeEllipse') }}</option>
        </select>
      </label>
      <label class="options__check">
        <input v-model="shape.filled" type="checkbox" /> {{ shape.filled ? t('options.fill') : t('options.stroke') }}
      </label>
      <label v-if="!shape.filled" class="options__number">
        {{ t('options.size') }} <input v-model.number="shape.lineWidth" type="number" min="1" max="200" />
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

/* An instruction rather than a control: there is no Alt-click for anything to hold. */
.options__hint {
  color: var(--ps-text-faint);
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
