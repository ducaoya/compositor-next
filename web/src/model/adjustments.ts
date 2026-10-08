/**
 * Adjustment layers: the settings, their identity values, and the parts of the maths that belong on
 * the CPU.
 *
 * The formulas here are the reference app's, not approximations of them — a Levels black point or a
 * Curves handle has to land where Photoshop puts it, or a project graded in one app looks wrong in
 * the other. Four of the twelve kinds reduce to a per-channel lookup table, and building that table
 * on the CPU means the shader does one texture fetch instead of a spline evaluation per pixel.
 */

export const ADJUSTMENT_KINDS = [
  'Hue/Saturation',
  'Levels',
  'Curves',
  'Exposure',
  'Gradient Map',
  'Grain',
  'Invert',
  'Black & White',
  'Color Balance',
  'Gaussian Blur',
  'Motion Blur',
  'Add Noise',
] as const

export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number]

export function adjustmentKindIndex(kind: AdjustmentKind): number {
  return ADJUSTMENT_KINDS.indexOf(kind)
}

/** The `adjust.kinds.*` key for a kind, whose names contain a slash and a space. */
export function adjustmentKindKey(kind: AdjustmentKind): string {
  return `adjust.kinds.${kind.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}

export interface Rgb {
  red: number
  green: number
  blue: number
}

export interface LevelRange {
  black: number
  gamma: number
  white: number
  outputBlack: number
  outputWhite: number
}

export interface CurvePoint {
  x: number
  y: number
}

export interface HueSaturationSettings {
  hue: number
  saturation: number
  lightness: number
  colorize: boolean
  /** The range the panel is showing. Not part of the rendering. */
  range?: string
  invertRange?: boolean
  /**
   * Per-range adjustments, keyed by range. Missing means the flat values above are the master,
   * which is what an adjustment written before the bands existed has.
   */
  adjustments?: Partial<Record<ColorRange, RangeAdjustment>>
  /** The bands themselves; a project may have moved one, so they are stored with it. */
  bands?: Partial<Record<ColorRange, HueBand>>
}

export interface ExposureSettings {
  exposure: number
  offset: number
  gamma: number
}

export interface GradientMapSettings {
  shadows: Rgb
  highlights: Rgb
  reversed: boolean
}

export interface GrainSettings {
  amount: number
  size: number
  roughness: number
  seed: number
}

export interface BlackWhiteSettings {
  reds: number
  yellows: number
  greens: number
  cyans: number
  blues: number
  magentas: number
  tint: boolean
  tintHue: number
  tintSaturation: number
}

export interface ColorBalanceSettings {
  shadowCyanRed: number
  shadowMagentaGreen: number
  shadowYellowBlue: number
  midCyanRed: number
  midMagentaGreen: number
  midYellowBlue: number
  highlightCyanRed: number
  highlightMagentaGreen: number
  highlightYellowBlue: number
  preserveLuminosity: boolean
}

/** One adjustment layer's settings, exactly as the `.comp` manifest holds them. */
export interface LayerAdjustment {
  kind: AdjustmentKind
  hue: number
  saturation: number
  lightness: number
  colorize: boolean
  hsvSettings?: HueSaturationSettings | null
  levels: { channel: string; ranges: LevelRange[] }
  curves: { channel: string; channels: CurvePoint[][] }
  exposureSettings?: ExposureSettings | null
  gradientMapSettings?: GradientMapSettings | null
  grainSettings?: GrainSettings | null
  blackWhiteSettings?: BlackWhiteSettings | null
  colorBalanceSettings?: ColorBalanceSettings | null
  blurRadius?: number | null
  motionAngle?: number | null
  motionDistance?: number | null
  noiseAmount?: number | null
  noiseGaussian?: boolean | null
  noiseMonochromatic?: boolean | null
  noiseSeed?: number | null
  [key: string]: unknown
}

// MARK: - Identity values

function identityLevels(): LevelRange {
  return { black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 }
}

/** Photoshop's Black & White defaults, which keep skin and foliage apart. */
export function defaultBlackWhite(): BlackWhiteSettings {
  return {
    reds: 40,
    yellows: 60,
    greens: 40,
    cyans: 60,
    blues: 20,
    magentas: 80,
    tint: false,
    tintHue: 40,
    tintSaturation: 20,
  }
}

export function defaultColorBalance(): ColorBalanceSettings {
  return {
    shadowCyanRed: 0,
    shadowMagentaGreen: 0,
    shadowYellowBlue: 0,
    midCyanRed: 0,
    midMagentaGreen: 0,
    midYellowBlue: 0,
    highlightCyanRed: 0,
    highlightMagentaGreen: 0,
    highlightYellowBlue: 0,
    preserveLuminosity: true,
  }
}

/**
 * A new adjustment layer of `kind`.
 *
 * Levels and Curves are never absent from a manifest — the reference writes an identity block for
 * every kind — so every adjustment carries them.
 */
export function identityAdjustment(kind: AdjustmentKind): LayerAdjustment {
  const base: LayerAdjustment = {
    kind,
    hue: 0,
    saturation: 0,
    lightness: 0,
    colorize: false,
    levels: { channel: 'RGB', ranges: [identityLevels(), identityLevels(), identityLevels(), identityLevels()] },
    curves: {
      channel: 'RGB',
      channels: [
        [{ x: 0, y: 0 }, { x: 255, y: 255 }],
        [{ x: 0, y: 0 }, { x: 255, y: 255 }],
        [{ x: 0, y: 0 }, { x: 255, y: 255 }],
        [{ x: 0, y: 0 }, { x: 255, y: 255 }],
      ],
    },
  }

  switch (kind) {
    case 'Hue/Saturation':
      // Photoshop opens Hue/Saturation on Master with a little saturation, so the hand is visible.
      base.saturation = 0
      break
    case 'Exposure':
      base.exposureSettings = { exposure: 0, offset: 0, gamma: 1 }
      break
    case 'Gradient Map':
      base.gradientMapSettings = {
        shadows: { red: 0, green: 0, blue: 0 },
        highlights: { red: 1, green: 1, blue: 1 },
        reversed: false,
      }
      break
    case 'Grain':
      base.grainSettings = { amount: 25, size: 1.5, roughness: 50, seed: 1 }
      break
    case 'Black & White':
      base.blackWhiteSettings = defaultBlackWhite()
      break
    case 'Color Balance':
      base.colorBalanceSettings = defaultColorBalance()
      break
    case 'Gaussian Blur':
      base.blurRadius = 10
      break
    case 'Motion Blur':
      base.motionAngle = 0
      base.motionDistance = 30
      break
    case 'Add Noise':
      base.noiseAmount = 20
      base.noiseGaussian = false
      base.noiseMonochromatic = false
      base.noiseSeed = 1
      break
    default:
      break
  }
  return base
}

// MARK: - Reading the settings back

export function resolvedLevels(adjustment: LayerAdjustment): LevelRange[] {
  const ranges = adjustment.levels?.ranges ?? []
  return Array.from({ length: 4 }, (_, index) => ({
    ...identityLevels(),
    ...(ranges[index] ?? {}),
  }))
}

export function resolvedCurves(adjustment: LayerAdjustment): CurvePoint[][] {
  const channels = adjustment.curves?.channels ?? []
  const straight: CurvePoint[] = [{ x: 0, y: 0 }, { x: 255, y: 255 }]
  return Array.from({ length: 4 }, (_, index) => {
    const points = channels[index]
    return points && points.length >= 2 ? points : straight
  })
}

export function resolvedExposure(adjustment: LayerAdjustment): ExposureSettings {
  return { exposure: 0, offset: 0, gamma: 1, ...(adjustment.exposureSettings ?? {}) }
}

export function resolvedHsv(adjustment: LayerAdjustment): HueSaturationSettings {
  if (adjustment.hsvSettings) return adjustment.hsvSettings
  return {
    hue: adjustment.hue ?? 0,
    saturation: adjustment.saturation ?? 0,
    lightness: adjustment.lightness ?? 0,
    colorize: adjustment.colorize ?? false,
  }
}

export function resolvedGradientMap(adjustment: LayerAdjustment): GradientMapSettings {
  return (
    adjustment.gradientMapSettings ?? {
      shadows: { red: 0, green: 0, blue: 0 },
      highlights: { red: 1, green: 1, blue: 1 },
      reversed: false,
    }
  )
}

export function resolvedGrain(adjustment: LayerAdjustment): GrainSettings {
  return { amount: 25, size: 1.5, roughness: 50, seed: 1, ...(adjustment.grainSettings ?? {}) }
}

export function resolvedBlackWhite(adjustment: LayerAdjustment): BlackWhiteSettings {
  return { ...defaultBlackWhite(), ...(adjustment.blackWhiteSettings ?? {}) }
}

export function resolvedColorBalance(adjustment: LayerAdjustment): ColorBalanceSettings {
  return { ...defaultColorBalance(), ...(adjustment.colorBalanceSettings ?? {}) }
}

// MARK: - Hue/Saturation's colour-range bands

/** The six ranges Photoshop splits the hue wheel into, and the master that covers all of it. */
export const COLOR_RANGES = ['master', 'reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const
export type ColorRange = (typeof COLOR_RANGES)[number]

/** A band in degrees, wrapping at 360: full strength between the range ends, fading to nothing at
 *  the falloffs. */
export interface HueBand {
  falloffStart: number
  rangeStart: number
  rangeEnd: number
  falloffEnd: number
}

/** Photoshop's starting bands. The six special ones tile the wheel with their falloffs overlapping. */
export const DEFAULT_BANDS: Record<ColorRange, HueBand> = {
  master: { falloffStart: 0, rangeStart: 0, rangeEnd: 360, falloffEnd: 360 },
  reds: { falloffStart: 315, rangeStart: 345, rangeEnd: 15, falloffEnd: 45 },
  yellows: { falloffStart: 15, rangeStart: 45, rangeEnd: 75, falloffEnd: 105 },
  greens: { falloffStart: 75, rangeStart: 105, rangeEnd: 135, falloffEnd: 165 },
  cyans: { falloffStart: 135, rangeStart: 165, rangeEnd: 195, falloffEnd: 225 },
  blues: { falloffStart: 195, rangeStart: 225, rangeEnd: 255, falloffEnd: 285 },
  magentas: { falloffStart: 255, rangeStart: 285, rangeEnd: 315, falloffEnd: 345 },
}

/** Degrees from `from` forward to `to`, always 0…360. */
export function forward(from: number, to: number): number {
  const delta = (to - from) % 360
  return delta < 0 ? delta + 360 : delta
}

/**
 * How strongly a band claims a hue, 0 to 1.
 *
 * Full strength between the range ends, ramping in and out across the falloffs, and wrapping so
 * that reds — which straddle zero — behave like the others.
 */
export function bandWeight(band: HueBand, hue: number): number {
  const span = forward(band.falloffStart, band.falloffEnd)
  // A band that covers the whole wheel — the master — claims everything.
  if (span <= 0) return 1
  const position = forward(band.falloffStart, hue)
  if (position > span) return 0
  const rampIn = forward(band.falloffStart, band.rangeStart)
  const plateauEnd = forward(band.falloffStart, band.rangeEnd)
  if (position < rampIn) return rampIn > 0 ? position / rampIn : 1
  if (position <= plateauEnd) return 1
  const rampOut = span - plateauEnd
  return rampOut > 0 ? (span - position) / rampOut : 1
}

/** One range's adjustment, as the manifest holds it. */
export interface RangeAdjustment {
  hue: number
  saturation: number
  lightness: number
}

function rangeAdjustments(adjustment: LayerAdjustment): Partial<Record<ColorRange, RangeAdjustment>> {
  const fromSettings = adjustment.hsvSettings?.adjustments
  if (fromSettings && Object.keys(fromSettings).length > 0) return fromSettings
  // Without per-range settings, the flat hue/saturation/lightness on the adjustment is the master.
  return {
    master: {
      hue: adjustment.hue ?? 0,
      saturation: adjustment.saturation ?? 0,
      lightness: adjustment.lightness ?? 0,
    },
  }
}

function bandsFor(adjustment: LayerAdjustment): Record<ColorRange, HueBand> {
  return { ...DEFAULT_BANDS, ...(adjustment.hsvSettings?.bands ?? {}) }
}

/**
 * The response table: what the six ranges add up to at every degree of hue.
 *
 * Precomputing it is the reference's own approach, and it turns a per-pixel loop over six weighted
 * bands into one texture fetch. The degrees are the *pixel's* hue, which is why this cannot be
 * folded into the value table the other kinds use.
 */
export function buildHueResponse(adjustment: LayerAdjustment): Uint8Array {
  const bands = bandsFor(adjustment)
  const adjustments = rangeAdjustments(adjustment)
  const out = new Uint8Array(360 * 4)
  for (let hue = 0; hue < 360; hue += 1) {
    let shift = 0
    let saturation = 0
    let lightness = 0
    for (const range of COLOR_RANGES) {
      const each = adjustments[range]
      if (!each || (each.hue === 0 && each.saturation === 0 && each.lightness === 0)) continue
      const weight = bandWeight(bands[range], hue)
      if (weight === 0) continue
      shift += each.hue * weight
      saturation += each.saturation * weight
      lightness += each.lightness * weight
    }
    // Packed into bytes the shader can unpack: a shift of ±180, and ±100 for the other two.
    out[hue * 4] = Math.round(Math.min(1, Math.max(0, (shift + 180) / 360)) * 255)
    out[hue * 4 + 1] = Math.round(Math.min(1, Math.max(0, (saturation + 100) / 200)) * 255)
    out[hue * 4 + 2] = Math.round(Math.min(1, Math.max(0, (lightness + 100) / 200)) * 255)
    out[hue * 4 + 3] = 255
  }
  return out
}

/** Whether the adjustment needs a response table at all, which is only Hue/Saturation. */
export function needsHueResponse(kind: AdjustmentKind): boolean {
  return kind === 'Hue/Saturation'
}

// MARK: - The lookup table

/** `lut_kind` in the shader: which of the four kinds is a per-channel table. */
export const LUT_KINDS: ReadonlySet<AdjustmentKind> = new Set([
  'Levels',
  'Curves',
  'Exposure',
  'Invert',
])

export function needsLut(kind: AdjustmentKind): boolean {
  return LUT_KINDS.has(kind)
}

function clamp(value: number, low: number, high: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(high, Math.max(low, value))
}

/** One Levels range, applied to an already-normalised 0–1 value. */
export function applyLevelRange(value: number, range: LevelRange): number {
  const black = clamp(range.black, 0, 254, 0)
  const white = clamp(range.white, black + 1, 255, 255)
  const gamma = clamp(range.gamma, 0.1, 9.99, 1)
  const outputBlack = clamp(range.outputBlack, 0, 255, 0)
  const outputWhite = clamp(range.outputWhite, 0, 255, 255)
  const input = Math.min(1, Math.max(0, (value * 255 - black) / (white - black)))
  return (outputBlack + Math.pow(input, 1 / gamma) * (outputWhite - outputBlack)) / 255
}

/**
 * A shape-preserving cubic Hermite through the points, as the reference evaluates a curve: the
 * slopes are the Fritsch–Carlson ones, so a curve never overshoots between two handles.
 */
export function curveValue(x: number, points: readonly CurvePoint[]): number {
  if (points.length < 2) return x
  const n = points.length
  let index = 0
  for (let i = 0; i < n - 1; i += 1) {
    if (points[i].x <= x) index = i
  }
  const deltas: number[] = []
  for (let i = 0; i < n - 1; i += 1) {
    deltas.push((points[i + 1].y - points[i].y) / (points[i + 1].x - points[i].x))
  }
  const slope = (j: number): number => {
    if (j === 0) return deltas[0]
    if (j === n - 1) return deltas[n - 2]
    if (deltas[j - 1] * deltas[j] <= 0) return 0
    return 2 / (1 / deltas[j - 1] + 1 / deltas[j])
  }
  const h = points[index + 1].x - points[index].x
  const t = Math.min(1, Math.max(0, (x - points[index].x) / h))
  const y =
    (2 * t * t * t - 3 * t * t + 1) * points[index].y +
    (t * t * t - 2 * t * t + t) * h * slope(index) +
    (-2 * t * t * t + 3 * t * t) * points[index + 1].y +
    (t * t * t - t * t) * h * slope(index + 1)
  return Math.min(255, Math.max(0, y))
}

/** sRGB → linear light, for Exposure, which works in linear. */
function toLinear(encoded: number): number {
  return encoded <= 0.04045 ? encoded / 12.92 : Math.pow((encoded + 0.055) / 1.055, 2.4)
}

function toEncoded(linear: number): number {
  if (linear <= 0) return 0
  if (linear >= 1) return 1
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055
}

/**
 * The 256 × 3 table a LUT kind reduces to: row 0 is red, row 1 green, row 2 blue, and each row holds
 * that channel's output for inputs 0…255.
 *
 * Returns null for a kind that is not a table, which is the shader's signal to compute in place.
 */
/** A precomputed table, and the shape the shader has to read it at. */
export interface AdjustmentTable {
  width: number
  height: number
  data: Uint8Array
}

export function buildLut(adjustment: LayerAdjustment): Uint8Array | null {
  const kind = adjustment.kind
  if (needsHueResponse(kind)) return buildHueResponse(adjustment)
  if (!needsLut(kind)) return null
  const table = new Uint8Array(256 * 3)

  if (kind === 'Invert') {
    for (let value = 0; value < 256; value += 1) {
      const inverted = 255 - value
      table[value] = inverted
      table[256 + value] = inverted
      table[512 + value] = inverted
    }
    return table
  }

  if (kind === 'Exposure') {
    const { exposure, offset, gamma } = resolvedExposure(adjustment)
    const scale = Math.pow(2, clamp(exposure, -20, 20, 0))
    const offsetValue = clamp(offset, -0.5, 0.5, 0)
    const gammaValue = clamp(gamma, 0.01, 9.99, 1)
    for (let value = 0; value < 256; value += 1) {
      const linear = Math.pow(Math.max(0, toLinear(value / 255) * scale + offsetValue), 1 / gammaValue)
      const output = Math.round(clamp(toEncoded(linear), 0, 1, 0) * 255)
      table[value] = output
      table[256 + value] = output
      table[512 + value] = output
    }
    return table
  }

  if (kind === 'Levels') {
    const ranges = resolvedLevels(adjustment)
    for (let value = 0; value < 256; value += 1) {
      // The composite range first, then the channel's own, as Photoshop orders them.
      const composed = applyLevelRange(value / 255, ranges[0])
      for (let channel = 0; channel < 3; channel += 1) {
        table[channel * 256 + value] = Math.round(
          clamp(applyLevelRange(composed, ranges[channel + 1]), 0, 1, 0) * 255,
        )
      }
    }
    return table
  }

  // Curves: the composite channel first, then the channel's own.
  const channels = resolvedCurves(adjustment)
  for (let value = 0; value < 256; value += 1) {
    const composed = curveValue(value, channels[0])
    for (let channel = 0; channel < 3; channel += 1) {
      table[channel * 256 + value] = Math.round(clamp(curveValue(composed, channels[channel + 1]), 0, 255, 0))
    }
  }
  return table
}

// MARK: - The shader's uniform

/** How many `vec4`s the adjustment uniform holds. Mirrored by `AdjustParams` in the WGSL. */
export const ADJUST_UNIFORM_VECS = 15

/**
 * Packs an adjustment into the uniform the shader reads.
 *
 * `direction` is the blur axis for a separable pass: the Gaussian runs twice, once across and once
 * down, and the motion blur once along its angle.
 */
export function packAdjustment(
  adjustment: LayerAdjustment,
  opacity: number,
  canvasWidth: number,
  canvasHeight: number,
  direction: [number, number] = [0, 0],
  hasMask = false,
): Float32Array {
  const out = new Float32Array(ADJUST_UNIFORM_VECS * 4)
  const hsvSettings = adjustment.hsvSettings
  const grain = resolvedGrain(adjustment)
  const gradient = resolvedGradientMap(adjustment)
  const blackWhite = resolvedBlackWhite(adjustment)
  const balance = resolvedColorBalance(adjustment)

  out.set([adjustmentKindIndex(adjustment.kind), opacity, canvasWidth, canvasHeight], 0)

  // Hue/Saturation: the per-range bands are not implemented, so the master values are what apply.
  const hsvHue = hsvSettings ? hsvSettings.hue : adjustment.hue ?? 0
  const hsvSaturation = hsvSettings ? hsvSettings.saturation : adjustment.saturation ?? 0
  const hsvLightness = hsvSettings ? hsvSettings.lightness : adjustment.lightness ?? 0
  const hsvColorize = (hsvSettings ? hsvSettings.colorize : adjustment.colorize) ?? false

  const exposure = resolvedExposure(adjustment)
  out.set([exposure.exposure, exposure.offset, exposure.gamma, hsvColorize ? 1 : 0], 4)
  out.set([hsvHue, hsvSaturation, hsvLightness, 0], 8)

  out.set([grain.amount, grain.size, grain.roughness, grain.seed >>> 0], 12)
  out.set(
    [
      adjustment.noiseAmount ?? 0,
      adjustment.noiseGaussian ? 1 : 0,
      adjustment.noiseMonochromatic ? 1 : 0,
      (adjustment.noiseSeed ?? 0) >>> 0,
    ],
    16,
  )

  const blurRadius =
    adjustment.kind === 'Gaussian Blur' ? adjustment.blurRadius ?? 0 : adjustment.motionDistance ?? 0
  out.set(
    [blurRadius, direction[0], direction[1], needsLut(adjustment.kind) || needsHueResponse(adjustment.kind) ? 1 : 0],
    20,
  )

  out.set([blackWhite.reds, blackWhite.yellows, blackWhite.greens, blackWhite.cyans], 24)
  out.set(
    [blackWhite.blues, blackWhite.magentas, blackWhite.tint ? 1 : 0, blackWhite.tintHue],
    28,
  )
  out.set(
    [
      blackWhite.tintSaturation,
      gradient.reversed ? 1 : 0,
      balance.preserveLuminosity ? 1 : 0,
      0,
    ],
    32,
  )
  out.set([gradient.shadows.red, gradient.shadows.green, gradient.shadows.blue, 0], 36)
  out.set([gradient.highlights.red, gradient.highlights.green, gradient.highlights.blue, 0], 40)
  out.set([balance.shadowCyanRed / 100, balance.shadowMagentaGreen / 100, balance.shadowYellowBlue / 100, 0], 44)
  out.set([balance.midCyanRed / 100, balance.midMagentaGreen / 100, balance.midYellowBlue / 100, 0], 48)
  out.set(
    [balance.highlightCyanRed / 100, balance.highlightMagentaGreen / 100, balance.highlightYellowBlue / 100, 0],
    52,
  )
  out.set([hasMask ? 1 : 0, 0, 0, 0], 56)
  return out
}
