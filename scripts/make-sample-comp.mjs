#!/usr/bin/env node
/**
 * Writes `examples/sample.comp`, a project that exercises the parts of the format worth checking:
 * a full-canvas background, a folder with its own opacity, a clipped layer, a layer mask, guides,
 * and every blend mode in the picker.
 *
 * It is also a second, independent writer of the format — the Rust core is the first — so a
 * disagreement between them shows up as a project one of them refuses.
 *
 *   node scripts/make-sample-comp.mjs [output.comp]
 */
import { createHash } from 'node:crypto'
import { deflateSync, crc32 } from 'node:zlib'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = resolve(process.argv[2] ?? join(ROOT, 'examples/sample.comp'))

const FORMAT = 'com.compositor.project'
const VERSION = 11
const WIDTH = 960
const HEIGHT = 640

const BLEND_MODES = [
  'Normal', 'Darken', 'Multiply', 'Color Burn', 'Linear Burn',
  'Lighten', 'Screen', 'Color Dodge', 'Linear Dodge (Add)',
  'Overlay', 'Soft Light', 'Hard Light', 'Vivid Light', 'Linear Light', 'Pin Light', 'Hard Mix',
  'Difference', 'Exclusion', 'Subtract', 'Divide',
  'Hue', 'Saturation', 'Color', 'Luminosity',
]

/**
 * A deterministic UUID, so regenerating the sample produces the same file: a fixture whose ids
 * change every time makes every diff of it useless.
 */
function uuid(seed) {
  const digest = createHash('sha1').update(seed).digest('hex').slice(0, 32).toUpperCase()
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `A${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-')
}

// MARK: - A minimal PNG encoder

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const check = Buffer.alloc(4)
  check.writeUInt32BE(crc32(body) >>> 0, 0)
  return Buffer.concat([length, body, check])
}

/** `pixels` is `width * height` samples: RGBA bytes, or one byte per pixel when grayscale. */
function encodePng(width, height, pixels, grayscale) {
  const channels = grayscale ? 1 : 4
  const stride = width * channels
  // Each row is prefixed with its filter type, and 0 means "none".
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = grayscale ? 0 : 6 // grayscale, or truecolour with alpha
  header[10] = 0
  header[11] = 0
  header[12] = 0
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// MARK: - Layers

function transform(origin, size) {
  return { origin, size, rotation: 0, flipX: false, flipY: false, sampling: 'High quality' }
}

function layer(name, options = {}) {
  const id = uuid(name)
  const record = {
    id,
    name,
    isVisible: true,
    transform: transform(options.origin ?? [0, 0], options.size ?? [WIDTH, HEIGHT]),
    isGroup: options.isGroup ?? false,
    opacity: options.opacity ?? 1,
    blendMode: options.blendMode ?? 'Normal',
  }
  if (!record.isGroup && options.pixels !== false) record.imageFile = `${id}.png`
  if (options.parentID) record.parentID = options.parentID
  if (options.clipTo) record.maskSourceID = options.clipTo
  if (options.mask) {
    record.maskFile = `${id}.mask.png`
    record.maskEnabled = true
  }
  if (options.rotation) record.transform.rotation = options.rotation
  return record
}

/** A diagonal gradient with a fine grid, so resampling and blends are both visible. */
function backgroundPixels() {
  const out = new Uint8Array(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const t = (x / WIDTH + y / HEIGHT) / 2
      const grid = x % 40 === 0 || y % 40 === 0 ? 24 : 0
      const index = (y * WIDTH + x) * 4
      out[index] = Math.min(255, Math.round(20 + 200 * t) + grid)
      out[index + 1] = Math.min(255, Math.round(40 + 120 * (1 - t)) + grid)
      out[index + 2] = Math.min(255, Math.round(70 + 160 * (1 - t)) + grid)
      out[index + 3] = 255
    }
  }
  return out
}

/** A hard-edged ring, which is the harshest thing to put through a resample. */
function ringPixels() {
  const out = new Uint8Array(WIDTH * HEIGHT * 4)
  const cx = WIDTH / 2
  const cy = HEIGHT / 2
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const distance = Math.hypot(x - cx, y - cy)
      const inside = distance < 260 && distance > 150
      const index = (y * WIDTH + x) * 4
      out[index] = 255
      out[index + 1] = 214
      out[index + 2] = 102
      out[index + 3] = inside ? 255 : 0
    }
  }
  return out
}

function softPixels() {
  const out = new Uint8Array(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y += 1) {
    const v = Math.round(255 * (0.25 + 0.75 * (1 - y / HEIGHT)))
    for (let x = 0; x < WIDTH; x += 1) {
      const index = (y * WIDTH + x) * 4
      out[index] = v
      out[index + 1] = Math.round(v * 0.6)
      out[index + 2] = Math.round(v * 0.4)
      out[index + 3] = 255
    }
  }
  return out
}

/** A mask that fades left to right, so the layer it belongs to has a soft edge. */
function maskPixels(revealing) {
  const out = new Uint8Array(WIDTH * HEIGHT)
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      out[y * WIDTH + x] = revealing ? 255 : Math.round(255 * Math.min(1, x / (WIDTH * 0.6)))
    }
  }
  return out
}

// MARK: - Build

const background = layer('Background')
const ring = layer('Ring', { blendMode: 'Overlay', opacity: 0.9 })
const clipped = layer('Clipped Glow', { blendMode: 'Screen', clipTo: ring.id })
const folder = layer('Folder', { isGroup: true, opacity: 0.6, pixels: false })
const inside = layer('Inside', { parentID: folder.id, blendMode: 'Soft Light', rotation: -6 })
const masked = layer('Masked', { blendMode: 'Normal', opacity: 0.75, mask: true })

// One layer per remaining blend mode, laid out as a strip along the bottom.
const strip = []
const columns = 6
const cellWidth = Math.floor(WIDTH / columns)
const cellHeight = 40
BLEND_MODES.filter((mode) => !['Overlay', 'Screen', 'Soft Light', 'Normal'].includes(mode)).forEach(
  (mode, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    strip.push(
      layer(`Blend ${mode}`, {
        size: [cellWidth, cellHeight],
        origin: [column * cellWidth, row * cellHeight],
        blendMode: mode,
      }),
    )
  },
)

const layers = [background, ring, clipped, folder, inside, masked, ...strip]

const manifest = {
  format: FORMAT,
  version: VERSION,
  colorSpace: 'sRGB',
  resolution: 72,
  documentID: uuid('document'),
  width: WIDTH,
  height: HEIGHT,
  activeLayerID: ring.id,
  layers,
  guides: [
    { id: uuid('guide-vertical'), axis: 'vertical', position: WIDTH / 2 },
    { id: uuid('guide-horizontal'), axis: 'horizontal', position: HEIGHT / 3 },
  ],
}

const images = new Map()
const add = (id, kind, bytes) => images.set(`${id}|${kind}`, [id, kind, bytes])
add(background.id, 'image', encodePng(WIDTH, HEIGHT, backgroundPixels(), false))
add(ring.id, 'image', encodePng(WIDTH, HEIGHT, ringPixels(), false))
add(clipped.id, 'image', encodePng(WIDTH, HEIGHT, softPixels(), false))
add(inside.id, 'image', encodePng(WIDTH, HEIGHT, softPixels(), false))
add(masked.id, 'image', encodePng(WIDTH, HEIGHT, backgroundPixels(), false))
add(masked.id, 'mask', encodePng(WIDTH, HEIGHT, maskPixels(false), true))
for (const record of strip) {
  add(record.id, 'image', encodePng(cellWidth, cellHeight, solidPixels(cellWidth, cellHeight), false))
}

function solidPixels(width, height) {
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      out[index] = 40 + Math.round((200 * x) / width)
      out[index + 1] = 120
      out[index + 2] = 220 - Math.round((160 * y) / height)
      out[index + 3] = 235
    }
  }
  return out
}

// MARK: - Write

rmSync(OUTPUT, { recursive: true, force: true })
mkdirSync(join(OUTPUT, 'images'), { recursive: true })

for (const [id, kind, bytes] of images.values()) {
  const name = kind === 'image' ? `${id}.png` : `${id}.mask.png`
  writeFileSync(join(OUTPUT, 'images', name), bytes)
}
writeFileSync(join(OUTPUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`${OUTPUT}`)
console.log(`  ${layers.length} layers, ${images.size} images, ${WIDTH} × ${HEIGHT}`)
