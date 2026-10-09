<script setup lang="ts">
/**
 * The adjustment editor, in the Properties panel the way Photoshop puts it.
 *
 * Each kind gets the controls it actually has and nothing else: no slider for a setting the kind
 * does not use. Every numeric field goes through `beginEdit`/`patch`/`endEdit`, so a drag on one is
 * a single undo step rather than one per input event.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  COLOR_RANGES,
  curveValue,
  DEFAULT_BANDS,
  HUE_BAND_EDGES,
  movedBandEdge,
  rangeValues,
  resolvedBand,
  resolvedBlackWhite,
  resolvedColorBalance,
  resolvedCurves,
  resolvedExposure,
  resolvedGradientMap,
  resolvedGrain,
  resolvedHsv,
  resolvedLevels,
  withBand,
  withRangeValues,
  type ColorRange,
  type CurvePoint,
  type HueBand,
  type HueSaturationSettings,
  type LevelRange,
  type ResolvedRange,
  type Rgb,
} from '../model/adjustments'
import {
  beginEdit,
  endEdit,
  patchAdjustment,
  patchAdjustmentSettings,
  useSession,
} from '../state/session'

const { t } = useI18n()
const { activeAdjustment } = useSession()

const adjustment = computed(() => activeAdjustment.value)

const CHANNELS = ['RGB', 'Red', 'Green', 'Blue'] as const
const BW_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const
const LEVEL_FIELDS = ['black', 'gamma', 'white', 'outputBlack', 'outputWhite'] as const
const CURVE_SIZE = 256

const BALANCE_GROUPS = [
  {
    prefix: 'shadows',
    axes: [
      { key: 'shadowCyanRed', label: 'cyanRed' },
      { key: 'shadowMagentaGreen', label: 'magentaGreen' },
      { key: 'shadowYellowBlue', label: 'yellowBlue' },
    ],
  },
  {
    prefix: 'midtones',
    axes: [
      { key: 'midCyanRed', label: 'cyanRed' },
      { key: 'midMagentaGreen', label: 'magentaGreen' },
      { key: 'midYellowBlue', label: 'yellowBlue' },
    ],
  },
  {
    prefix: 'highlights',
    axes: [
      { key: 'highlightCyanRed', label: 'cyanRed' },
      { key: 'highlightMagentaGreen', label: 'magentaGreen' },
      { key: 'highlightYellowBlue', label: 'yellowBlue' },
    ],
  },
] as const

function channelIndex(name: string): number {
  return Math.max(0, CHANNELS.indexOf(name as (typeof CHANNELS)[number]))
}

/** One gesture: snapshot, change, commit. */
function gesture(label: string, body: () => void): void {
  beginEdit(label)
  body()
  endEdit()
}

function setScalar(key: string, value: unknown): void {
  patchAdjustment({ [key]: value })
}

function setSetting(block: string, key: string, value: unknown): void {
  patchAdjustmentSettings(block, { [key]: value })
}

function numberFromEvent(event: Event): number {
  return Number((event.target as HTMLInputElement).value)
}

function checkedFromEvent(event: Event): boolean {
  return (event.target as HTMLInputElement).checked
}

function rgbToHex(colour: Rgb): string {
  const part = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${part(colour.red)}${part(colour.green)}${part(colour.blue)}`
}

function hexToRgb(hex: string): Rgb {
  return {
    red: Number.parseInt(hex.slice(1, 3), 16) / 255,
    green: Number.parseInt(hex.slice(3, 5), 16) / 255,
    blue: Number.parseInt(hex.slice(5, 7), 16) / 255,
  }
}

// MARK: - Hue/Saturation's colour ranges

/**
 * Which range the three sliders are pointed at.
 *
 * The choice lives with the adjustment rather than in component state, so switching layers and
 * coming back shows the range you were working on and a reopened project does too. It is not part
 * of the rendering — `buildHueResponse` reads `adjustments`, never `range`.
 */
const hsvRange = computed<ColorRange>(() => {
  const chosen = adjustment.value?.hsvSettings?.range
  return COLOR_RANGES.includes(chosen as ColorRange) ? (chosen as ColorRange) : 'master'
})

function selectHsvRange(event: Event): void {
  const chosen = (event.target as HTMLSelectElement).value as ColorRange
  if (!COLOR_RANGES.includes(chosen)) return
  gesture('Range', () => setHsvSettings({ range: chosen }))
}

function hsvValues(): ResolvedRange {
  const current = adjustment.value
  if (!current) return { hue: 0, saturation: 0, lightness: 0 }
  return rangeValues(current, hsvRange.value)
}

function hsvBand(): HueBand {
  const current = adjustment.value
  if (!current) return DEFAULT_BANDS.master
  return resolvedBand(current, hsvRange.value)
}

/** Bumped whenever an edge is edited, so the four number fields re-read the stored band. */
const edgeEcho = ref(0)

/**
 * Writes the whole settings block rather than poking at it.
 *
 * `patchAdjustmentSettings` merges at the block level, and the range writers are already pure
 * functions in the model that keep every other range where it was, so a whole-object write is both
 * the simplest thing here and the thing the model's tests cover.
 */
function setHsvSettings(settings: Partial<HueSaturationSettings>): void {
  patchAdjustmentSettings('hsvSettings', { ...settings })
}

/**
 * The master writes `adjustments.master`, exactly like the six bands.
 *
 * One code path for all seven ranges, and the flat `hue`/`saturation`/`lightness` fields stay as the
 * shape an older project stored its master in — `masterValues` reads either.
 */
function setHsvValue(key: keyof ResolvedRange, value: number): void {
  const current = adjustment.value
  if (!current) return
  const range = hsvRange.value
  setHsvSettings(withRangeValues(current, range, { ...rangeValues(current, range), [key]: value }))
}

function setHsvEdge(key: keyof HueBand, value: number): void {
  const current = adjustment.value
  if (!current) return
  const range = hsvRange.value
  const band = movedBandEdge(resolvedBand(current, range), key, value)
  gesture('Colour range', () => setHsvSettings(withBand(current, range, band)))
  // A clamped or impossible edit still has to show what was stored, and Vue will not patch a `value`
  // binding that did not change — typing 100 into a field that clamps back to 100 again, say.
  edgeEcho.value += 1
}

/** Back to nothing for the selected range, which is also how the table is emptied. */
function resetHsvRange(): void {
  const current = adjustment.value
  if (!current) return
  const range = hsvRange.value
  gesture('Reset range', () => setHsvSettings(withRangeValues(current, range, { hue: 0, saturation: 0, lightness: 0 })))
}

// MARK: - Levels

function levelRange(): LevelRange {
  const current = adjustment.value
  if (!current) return { black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 }
  return resolvedLevels(current)[channelIndex(current.levels.channel)]
}

function setLevelRange(key: keyof LevelRange, value: number): void {
  const current = adjustment.value
  if (!current) return
  const ranges = current.levels.ranges.map((range) => ({ ...range }))
  while (ranges.length < 4) {
    ranges.push({ black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 })
  }
  ranges[channelIndex(current.levels.channel)] = { ...ranges[channelIndex(current.levels.channel)], [key]: value }
  patchAdjustment({ levels: { ...current.levels, ranges } })
}

// MARK: - The curve editor

const dragIndex = ref<number | null>(null)

const curvePoints = computed<CurvePoint[]>(() => {
  const current = adjustment.value
  if (!current) return []
  return resolvedCurves(current)[channelIndex(current.curves.channel)]
})

const curvePath = computed(() => {
  const points = curvePoints.value
  if (points.length < 2) return ''
  const parts: string[] = []
  for (let x = 0; x <= CURVE_SIZE; x += 2) {
    const y = CURVE_SIZE - curveValue(x, points)
    parts.push(`${x === 0 ? 'M' : 'L'}${x} ${y.toFixed(1)}`)
  }
  return parts.join(' ')
})

function setCurvePoints(points: CurvePoint[]): void {
  const current = adjustment.value
  if (!current) return
  const channels = resolvedCurves(current).map((channel) => [...channel])
  channels[channelIndex(current.curves.channel)] = points
  patchAdjustment({ curves: { ...current.curves, channels } })
}

function curveCoordinates(event: PointerEvent, element: SVGSVGElement): CurvePoint {
  const bounds = element.getBoundingClientRect()
  const x = Math.round(((event.clientX - bounds.left) / bounds.width) * CURVE_SIZE)
  const y = Math.round(CURVE_SIZE - ((event.clientY - bounds.top) / bounds.height) * CURVE_SIZE)
  return { x: Math.max(0, Math.min(255, x)), y: Math.max(0, Math.min(255, y)) }
}

function onCurveDown(event: PointerEvent, element: SVGSVGElement): void {
  const points = [...curvePoints.value]
  const at = curveCoordinates(event, element)
  const nearest = points.findIndex((point) => Math.abs(point.x - at.x) <= 8)
  if (nearest >= 0 && !event.altKey) {
    dragIndex.value = nearest
    return
  }
  if (nearest >= 0 && event.altKey) {
    // Alt-clicking a handle removes it, but never one of the two ends.
    if (points.length <= 2 || nearest === 0 || nearest === points.length - 1) return
    points.splice(nearest, 1)
    gesture('Curves', () => setCurvePoints(points))
    return
  }
  let insert = points.findIndex((point) => point.x > at.x)
  if (insert <= 0) insert = points.length
  points.splice(insert, 0, at)
  dragIndex.value = insert
  gesture('Curves', () => setCurvePoints(points))
}

function onCurveMove(event: PointerEvent, element: SVGSVGElement): void {
  const index = dragIndex.value
  if (index === null) return
  const points = [...curvePoints.value]
  const at = curveCoordinates(event, element)
  const first = index === 0
  const last = index === points.length - 1
  // The ends stay pinned to x = 0 and x = 255, which is what makes a curve span the whole range.
  const x = first ? 0 : last ? 255 : at.x
  points[index] = { x, y: at.y }
  points.sort((a, b) => a.x - b.x)
  dragIndex.value = points.findIndex((point) => point.x === x)
  gesture('Curves', () => setCurvePoints(points))
}
</script>

<template>
  <div v-if="adjustment" class="adjust">
    <!-- Hue/Saturation -->
    <template v-if="adjustment.kind === 'Hue/Saturation'">
      <label class="row">
        <span>{{ t('adjust.range') }}</span>
        <select class="input" :value="hsvRange" @change="selectHsvRange($event)">
          <option v-for="range in COLOR_RANGES" :key="range" :value="range">
            {{ t(`adjust.ranges.${range}`) }}
          </option>
        </select>
      </label>
      <label class="slider">
        <span>{{ t('adjust.hue') }}</span>
        <input
          type="range"
          min="-180"
          max="180"
          :value="hsvValues().hue"
          @pointerdown="beginEdit('Hue')"
          @input="setHsvValue('hue', numberFromEvent($event))"
          @change="endEdit()"
          @pointerup="endEdit()"
        />
        <output>{{ Math.round(hsvValues().hue) }}</output>
      </label>
      <label class="slider">
        <span>{{ t('adjust.saturation') }}</span>
        <input
          type="range"
          min="-100"
          max="100"
          :value="hsvValues().saturation"
          @pointerdown="beginEdit('Saturation')"
          @input="setHsvValue('saturation', numberFromEvent($event))"
          @change="endEdit()"
          @pointerup="endEdit()"
        />
        <output>{{ Math.round(hsvValues().saturation) }}</output>
      </label>
      <label class="slider">
        <span>{{ t('adjust.lightness') }}</span>
        <input
          type="range"
          min="-100"
          max="100"
          :value="hsvValues().lightness"
          @pointerdown="beginEdit('Lightness')"
          @input="setHsvValue('lightness', numberFromEvent($event))"
          @change="endEdit()"
          @pointerup="endEdit()"
        />
        <output>{{ Math.round(hsvValues().lightness) }}</output>
      </label>

      <!--
        The band, only for a range that has one. Four numbers rather than four more sliders: the
        edges are geometry, and the panel is already six sliders deep in this kind alone.
      -->
      <template v-if="hsvRange !== 'master'">
        <p class="note">{{ t('adjust.bandsNote') }}</p>
        <div class="grid" :key="edgeEcho">
          <label v-for="edge in HUE_BAND_EDGES" :key="edge" class="row row--tiny">
            <span>{{ t(`adjust.edges.${edge}`) }}</span>
            <input
              class="input"
              type="number"
              min="0"
              max="360"
              step="1"
              :value="Math.round(hsvBand()[edge])"
              @change="setHsvEdge(edge, numberFromEvent($event))"
            />
          </label>
        </div>
      </template>

      <label class="check">
        <input
          type="checkbox"
          :checked="resolvedHsv(adjustment).colorize"
          @change="gesture('Colorize', () => patchAdjustment({ colorize: checkedFromEvent($event) }))"
        />
        {{ t('adjust.colorize') }}
      </label>
      <button type="button" class="reset" @click="resetHsvRange()">{{ t('adjust.resetRange') }}</button>
    </template>

    <!-- Levels -->
    <template v-else-if="adjustment.kind === 'Levels'">
      <label class="row">
        <span>{{ t('adjust.channel') }}</span>
        <select
          class="input"
          :value="adjustment.levels.channel"
          @change="
            gesture('Channel', () =>
              patchAdjustment({
                levels: { ...adjustment!.levels, channel: ($event.target as HTMLSelectElement).value },
              }),
            )
          "
        >
          <option v-for="name in CHANNELS" :key="name" :value="name">
            {{ t(`adjust.channels.${name.toLowerCase()}`) }}
          </option>
        </select>
      </label>
      <div class="grid">
        <label v-for="field in LEVEL_FIELDS" :key="field" class="row row--tiny">
          <span>{{ t(`adjust.${field}`) }}</span>
          <input
            class="input"
            type="number"
            :step="field === 'gamma' ? 0.01 : 1"
            :value="levelRange()[field]"
            @change="gesture('Levels', () => setLevelRange(field, numberFromEvent($event)))"
          />
        </label>
      </div>
      <p class="note">{{ t('adjust.levelsNote') }}</p>
    </template>

    <!-- Curves -->
    <template v-else-if="adjustment.kind === 'Curves'">
      <label class="row">
        <span>{{ t('adjust.channel') }}</span>
        <select
          class="input"
          :value="adjustment.curves.channel"
          @change="
            gesture('Channel', () =>
              patchAdjustment({
                curves: { ...adjustment!.curves, channel: ($event.target as HTMLSelectElement).value },
              }),
            )
          "
        >
          <option v-for="name in CHANNELS" :key="name" :value="name">
            {{ t(`adjust.channels.${name.toLowerCase()}`) }}
          </option>
        </select>
      </label>
      <svg
        class="curve"
        :viewBox="`0 0 ${CURVE_SIZE} ${CURVE_SIZE}`"
        @pointerdown="onCurveDown($event, $event.currentTarget as SVGSVGElement)"
        @pointermove="onCurveMove($event, $event.currentTarget as SVGSVGElement)"
        @pointerup="dragIndex = null"
        @pointerleave="dragIndex = null"
      >
        <rect x="0" y="0" :width="CURVE_SIZE" :height="CURVE_SIZE" class="curve__grid" />
        <line
          v-for="n in 3"
          :key="`v${n}`"
          :x1="(CURVE_SIZE / 4) * n"
          y1="0"
          :x2="(CURVE_SIZE / 4) * n"
          :y2="CURVE_SIZE"
          class="curve__line"
        />
        <line
          v-for="n in 3"
          :key="`h${n}`"
          x1="0"
          :y1="(CURVE_SIZE / 4) * n"
          :x2="CURVE_SIZE"
          :y2="(CURVE_SIZE / 4) * n"
          class="curve__line"
        />
        <line x1="0" :y1="CURVE_SIZE" :x2="CURVE_SIZE" y2="0" class="curve__diagonal" />
        <path :d="curvePath" class="curve__path" />
        <circle
          v-for="(point, index) in curvePoints"
          :key="index"
          :cx="point.x"
          :cy="CURVE_SIZE - point.y"
          r="5"
          class="curve__handle"
        />
      </svg>
      <p class="note">{{ t('adjust.curvesNote') }}</p>
    </template>

    <!-- Exposure -->
    <template v-else-if="adjustment.kind === 'Exposure'">
      <label class="slider">
        <span>{{ t('adjust.exposure') }}</span>
        <input
          type="range"
          min="-5"
          max="5"
          step="0.01"
          :value="resolvedExposure(adjustment).exposure"
          @pointerdown="beginEdit('Exposure')"
          @input="setSetting('exposureSettings', 'exposure', numberFromEvent($event))"
          @change="endEdit()"
          @pointerup="endEdit()"
        />
        <output>{{ resolvedExposure(adjustment).exposure.toFixed(2) }}</output>
      </label>
      <label class="slider">
        <span>{{ t('adjust.offset') }}</span>
        <input
          type="range"
          min="-0.5"
          max="0.5"
          step="0.01"
          :value="resolvedExposure(adjustment).offset"
          @pointerdown="beginEdit('Offset')"
          @input="setSetting('exposureSettings', 'offset', numberFromEvent($event))"
          @change="endEdit()"
          @pointerup="endEdit()"
        />
        <output>{{ resolvedExposure(adjustment).offset.toFixed(2) }}</output>
      </label>
      <label class="slider">
        <span>{{ t('adjust.gamma') }}</span>
        <input
          type="range"
          min="0.1"
          max="3"
          step="0.01"
          :value="resolvedExposure(adjustment).gamma"
          @pointerdown="beginEdit('Gamma')"
          @input="setSetting('exposureSettings', 'gamma', numberFromEvent($event))"
          @change="endEdit()"
          @pointerup="endEdit()"
        />
        <output>{{ resolvedExposure(adjustment).gamma.toFixed(2) }}</output>
      </label>
    </template>

    <!-- Gradient Map -->
    <template v-else-if="adjustment.kind === 'Gradient Map'">
      <div class="swatches">
        <label class="swatch">
          <span>{{ t('adjust.shadows') }}</span>
          <input
            type="color"
            :value="rgbToHex(resolvedGradientMap(adjustment).shadows)"
            @input="
              gesture('Gradient Map', () =>
                setSetting('gradientMapSettings', 'shadows', hexToRgb(($event.target as HTMLInputElement).value)),
              )
            "
          />
        </label>
        <label class="swatch">
          <span>{{ t('adjust.highlights') }}</span>
          <input
            type="color"
            :value="rgbToHex(resolvedGradientMap(adjustment).highlights)"
            @input="
              gesture('Gradient Map', () =>
                setSetting('gradientMapSettings', 'highlights', hexToRgb(($event.target as HTMLInputElement).value)),
              )
            "
          />
        </label>
      </div>
      <label class="check">
        <input
          type="checkbox"
          :checked="resolvedGradientMap(adjustment).reversed"
          @change="gesture('Gradient Map', () => setSetting('gradientMapSettings', 'reversed', checkedFromEvent($event)))"
        />
        {{ t('adjust.reversed') }}
      </label>
    </template>

    <!-- Add Noise -->
    <template v-else-if="adjustment.kind === 'Add Noise'">
      <label class="slider">
        <span>{{ t('adjust.amount') }}</span>
        <input
          type="range"
          min="0"
          max="400"
          step="0.1"
          :value="adjustment.noiseAmount ?? 0"
          @pointerdown="beginEdit('Amount')"
          @input="setScalar('noiseAmount', numberFromEvent($event))"
          @change="endEdit()"
          @pointerup="endEdit()"
        />
        <output>{{ Math.round(adjustment.noiseAmount ?? 0) }}</output>
      </label>
      <label class="check">
        <input
          type="checkbox"
          :checked="adjustment.noiseGaussian ?? false"
          @change="gesture('Noise', () => setScalar('noiseGaussian', checkedFromEvent($event)))"
        />
        {{ t('adjust.gaussian') }}
      </label>
      <label class="check">
        <input
          type="checkbox"
          :checked="adjustment.noiseMonochromatic ?? false"
          @change="gesture('Noise', () => setScalar('noiseMonochromatic', checkedFromEvent($event)))"
        />
        {{ t('adjust.monochromatic') }}
      </label>
    </template>

    <!-- Grain -->
    <template v-else-if="adjustment.kind === 'Grain'">
      <label class="slider">
        <span>{{ t('adjust.amount') }}</span>
        <input
          type="range"
          min="0"
          max="100"
          step="0.1"
          :value="resolvedGrain(adjustment).amount"
          @pointerdown="beginEdit('Amount')"
          @input="setSetting('grainSettings', 'amount', numberFromEvent($event))"
          @change="endEdit()"
          @pointerup="endEdit()"
        />
        <output>{{ Math.round(resolvedGrain(adjustment).amount) }}</output>
      </label>
      <label class="slider">
        <span>{{ t('adjust.size') }}</span>
        <input
          type="range"
          min="0.5"
          max="20"
          step="0.1"
          :value="resolvedGrain(adjustment).size"
          @pointerdown="beginEdit('Size')"
          @input="setSetting('grainSettings', 'size', numberFromEvent($event))"
          @change="endEdit()"
          @pointerup="endEdit()"
        />
        <output>{{ resolvedGrain(adjustment).size.toFixed(1) }}</output>
      </label>
      <label class="slider">
        <span>{{ t('adjust.roughness') }}</span>
        <input
          type="range"
          min="0"
          max="100"
          :value="resolvedGrain(adjustment).roughness"
          @pointerdown="beginEdit('Roughness')"
          @input="setSetting('grainSettings', 'roughness', numberFromEvent($event))"
          @change="endEdit()"
          @pointerup="endEdit()"
        />
        <output>{{ Math.round(resolvedGrain(adjustment).roughness) }}</output>
      </label>
    </template>

    <!-- Black & White -->
    <template v-else-if="adjustment.kind === 'Black & White'">
      <label v-for="key in BW_RANGES" :key="key" class="slider">
        <span>{{ t(`adjust.ranges.${key}`) }}</span>
        <input
          type="range"
          min="-200"
          max="300"
          :value="resolvedBlackWhite(adjustment)[key]"
          @pointerdown="beginEdit('Black & White')"
          @input="setSetting('blackWhiteSettings', key, numberFromEvent($event))"
          @change="endEdit()"
          @pointerup="endEdit()"
        />
        <output>{{ Math.round(resolvedBlackWhite(adjustment)[key]) }}</output>
      </label>
      <label class="check">
        <input
          type="checkbox"
          :checked="resolvedBlackWhite(adjustment).tint"
          @change="gesture('Tint', () => setSetting('blackWhiteSettings', 'tint', checkedFromEvent($event)))"
        />
        {{ t('adjust.tint') }}
      </label>
      <template v-if="resolvedBlackWhite(adjustment).tint">
        <label class="slider">
          <span>{{ t('adjust.tintHue') }}</span>
          <input
            type="range"
            min="0"
            max="360"
            :value="resolvedBlackWhite(adjustment).tintHue"
            @pointerdown="beginEdit('Tint Hue')"
            @input="setSetting('blackWhiteSettings', 'tintHue', numberFromEvent($event))"
            @change="endEdit()"
            @pointerup="endEdit()"
          />
          <output>{{ Math.round(resolvedBlackWhite(adjustment).tintHue) }}</output>
        </label>
        <label class="slider">
          <span>{{ t('adjust.saturation') }}</span>
          <input
            type="range"
            min="0"
            max="100"
            :value="resolvedBlackWhite(adjustment).tintSaturation"
            @pointerdown="beginEdit('Tint Saturation')"
            @input="setSetting('blackWhiteSettings', 'tintSaturation', numberFromEvent($event))"
            @change="endEdit()"
            @pointerup="endEdit()"
          />
          <output>{{ Math.round(resolvedBlackWhite(adjustment).tintSaturation) }}</output>
        </label>
      </template>
    </template>

    <!-- Colour Balance -->
    <template v-else-if="adjustment.kind === 'Color Balance'">
      <div v-for="group in BALANCE_GROUPS" :key="group.prefix">
        <div class="group__title">{{ t(`adjust.balance.${group.prefix}`) }}</div>
        <label v-for="axis in group.axes" :key="axis.key" class="slider">
          <span>{{ t(`adjust.balance.${axis.label}`) }}</span>
          <input
            type="range"
            min="-100"
            max="100"
            :value="resolvedColorBalance(adjustment)[axis.key]"
            @pointerdown="beginEdit('Colour Balance')"
            @input="setSetting('colorBalanceSettings', axis.key, numberFromEvent($event))"
            @change="endEdit()"
            @pointerup="endEdit()"
          />
          <output>{{ Math.round(resolvedColorBalance(adjustment)[axis.key]) }}</output>
        </label>
      </div>
      <label class="check">
        <input
          type="checkbox"
          :checked="resolvedColorBalance(adjustment).preserveLuminosity"
          @change="
            gesture('Preserve Luminosity', () =>
              setSetting('colorBalanceSettings', 'preserveLuminosity', checkedFromEvent($event)),
            )
          "
        />
        {{ t('adjust.preserveLuminosity') }}
      </label>
    </template>

    <!-- Gaussian Blur and Motion Blur -->
    <template v-else-if="adjustment.kind === 'Gaussian Blur' || adjustment.kind === 'Motion Blur'">
      <label v-if="adjustment.kind === 'Gaussian Blur'" class="slider">
        <span>{{ t('adjust.radius') }}</span>
        <input
          type="range"
          min="0.1"
          max="250"
          step="0.1"
          :value="adjustment.blurRadius ?? 0"
          @pointerdown="beginEdit('Radius')"
          @input="setScalar('blurRadius', numberFromEvent($event))"
          @change="endEdit()"
          @pointerup="endEdit()"
        />
        <output>{{ (adjustment.blurRadius ?? 0).toFixed(1) }}</output>
      </label>
      <template v-else>
        <label class="slider">
          <span>{{ t('adjust.angle') }}</span>
          <input
            type="range"
            min="-90"
            max="90"
            :value="adjustment.motionAngle ?? 0"
            @pointerdown="beginEdit('Angle')"
            @input="setScalar('motionAngle', numberFromEvent($event))"
            @change="endEdit()"
            @pointerup="endEdit()"
          />
          <output>{{ Math.round(adjustment.motionAngle ?? 0) }}</output>
        </label>
        <label class="slider">
          <span>{{ t('adjust.distance') }}</span>
          <input
            type="range"
            min="1"
            max="500"
            :value="adjustment.motionDistance ?? 0"
            @pointerdown="beginEdit('Distance')"
            @input="setScalar('motionDistance', numberFromEvent($event))"
            @change="endEdit()"
            @pointerup="endEdit()"
          />
          <output>{{ Math.round(adjustment.motionDistance ?? 0) }}</output>
        </label>
      </template>
      <p class="note">{{ t('adjust.blurNote') }}</p>
    </template>

    <p v-else-if="adjustment.kind === 'Invert'" class="note">{{ t('adjust.invertNote') }}</p>
  </div>
</template>

<style scoped>
.adjust {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.group__title {
  margin-top: 2px;
  color: var(--ps-text-faint);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.slider {
  display: grid;
  grid-template-columns: 62px 1fr 34px;
  gap: 5px;
  align-items: center;
}

.slider > span {
  overflow: hidden;
  color: var(--ps-text-dim);
  white-space: nowrap;
  text-overflow: ellipsis;
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

.row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.row > span {
  width: 62px;
  color: var(--ps-text-dim);
}

.row--tiny > span {
  width: 52px;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 8px;
}

.input {
  flex: 1;
  min-width: 0;
  padding: 2px 4px;
  border: 1px solid var(--ps-line);
  border-radius: var(--ps-radius);
  background: var(--ps-well);
  color: var(--ps-text);
}

.check {
  display: flex;
  gap: 5px;
  align-items: center;
  color: var(--ps-text-dim);
}

.swatches {
  display: flex;
  gap: 8px;
}

.swatch {
  display: flex;
  gap: 5px;
  align-items: center;
  color: var(--ps-text-dim);
}

.swatch input {
  width: 28px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--ps-line);
  background: none;
  cursor: pointer;
}

.curve {
  width: 100%;
  aspect-ratio: 1;
  border: 1px solid var(--ps-line-hard);
  background: var(--ps-well);
  cursor: crosshair;
}

.curve__grid {
  fill: #1e1e1e;
}

.curve__line {
  stroke: #3a3a3a;
  stroke-width: 1;
}

.curve__diagonal {
  stroke: #4a4a4a;
  stroke-width: 1;
  stroke-dasharray: 4 4;
}

.curve__path {
  fill: none;
  stroke: #d8d8d8;
  stroke-width: 1.5;
}

.curve__handle {
  fill: #d8d8d8;
  stroke: #1a1a1a;
  stroke-width: 1;
}

.note {
  margin: 0;
  color: var(--ps-text-faint);
  font-size: 10px;
  line-height: 1.5;
}

/* A plain secondary button, since the panel has no button style of its own. */
.reset {
  align-self: flex-start;
  padding: 2px 8px;
  border: 1px solid var(--ps-line);
  border-radius: var(--ps-radius);
  background: var(--ps-well);
  color: var(--ps-text-dim);
  cursor: pointer;
}

.reset:hover {
  border-color: var(--ps-line-hard);
  color: var(--ps-text);
}
</style>
