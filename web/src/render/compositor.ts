/**
 * The GPU compositor.
 *
 * The document is composited one layer at a time into an offscreen accumulation texture, exactly
 * as the reference app composites into a Core Graphics context. Two accumulation textures are
 * ping-ponged because a render pass cannot read its own target.
 *
 * Everything stays on the GPU between frames: a pan or a zoom only changes the display uniform.
 * Layer pixels are uploaded once, when a layer's image is decoded.
 *
 * Format is `rgba16float` for the accumulation so repeated blending does not quantize to 8 bits.
 * The blend maths runs in **sRGB-encoded values**, matching Photoshop, the reference app and
 * `model/blend.ts`.
 */

import shaderSource from './compositor.wgsl?raw'
import adjustSource from './adjust.wgsl?raw'
import { BLEND_MODES, type BlendModeName, type Transform } from '../model/types'
import {
  ADJUST_UNIFORM_VECS,
  buildLut,
  packAdjustment,
  type LayerAdjustment,
} from '../model/adjustments'

/**
 * The two shader files as one module.
 *
 * WGSL has no `#include`, and the order matters: `compositor.wgsl` declares the adjustment uniform
 * and its bindings, which `adjust.wgsl` then uses.
 */
const MODULE_SOURCE = `${shaderSource}\n${adjustSource}`

const ACCUM_FORMAT: GPUTextureFormat = 'rgba16float'
/** Bytes per layer of composite uniforms; also the dynamic-offset stride. */
const PARAMS_BYTES = 64
/** How many adjustment passes one frame may encode before the uniform slots wrap. */
const ADJUST_UNIFORM_SLOTS = 32
const DISPLAY_BYTES = 48

export interface LayerDraw {
  kind: 'layer'
  id: string
  /** Null for a layer with no pixels yet: it draws nothing. */
  texture: GPUTexture | null
  mask: GPUTexture | null
  transform: Transform
  /** Already multiplied through every enclosing folder. */
  opacity: number
  blendMode: BlendModeName
}

/**
 * An adjustment layer, which changes everything composited below it rather than drawing anything of
 * its own.
 *
 * `lut` is the 256 × 3 table Levels, Curves, Exposure and Invert reduce to; the other kinds compute
 * in the shader from `adjustment`.
 */
export interface AdjustmentDraw {
  kind: 'adjustment'
  id: string
  opacity: number
  adjustment: LayerAdjustment
  /** The adjustment layer's own mask, if it has one. */
  mask: GPUTexture | null
}

export type DrawItem = LayerDraw | AdjustmentDraw

export interface ViewState {
  zoom: number
  panX: number
  panY: number
}

interface Frame {
  device: GPUDevice
  context: GPUCanvasContext
  format: GPUTextureFormat
  compositePipeline: GPURenderPipeline
  /** The adjustment pass, writing to the accumulation's own format. */
  adjustPipeline: GPURenderPipeline
  adjustLayout: GPUBindGroupLayout
  /**
   * Adjustment uniforms, one slot per pass with a dynamic offset — the same arrangement the
   * composite uses, and for the same reason. A single buffer written twice before one submit would
   * leave both passes reading the second write: a two-pass Gaussian would blur one way twice.
   */
  adjustUniform: GPUBuffer
  adjustSampler: GPUSampler
  /** The 256 × 3 tables the LUT kinds bake to, by adjustment layer. */
  luts: Map<string, { texture: GPUTexture; signature: string }>
  /**
   * The same shader, writing to an 8-bit target. A pipeline's attachment format is fixed at
   * creation, and the accumulation is `rgba16float` while an export has to be readable as bytes,
   * so flattening is a second pipeline rather than a second shader.
   */
  flattenPipeline: GPURenderPipeline
  displayPipeline: GPURenderPipeline
  emptyBindGroup: GPUBindGroup
  compositeLayout: GPUBindGroupLayout
  displayLayout: GPUBindGroupLayout
  displayUniform: GPUBuffer
  displayBindGroup: GPUBindGroup
  compositeUniforms: GPUBuffer
  uniformScratch: Float32Array
  uniformStride: number
  linearSampler: GPUSampler
  nearestSampler: GPUSampler
  dummy: GPUTexture
  accum: [GPUTexture, GPUTexture] | null
  /** Layer textures by asset key, so a repaint can update the one already on the GPU. */
  layerTextures: Map<string, GPUTexture>
  /** The texture holding the last composited frame. */
  last: GPUTexture | null
  exportTexture: GPUTexture | null
  exportSize: [number, number]
  size: [number, number]
  scratch: Float32Array
}

export interface CompositorOptions {
  /**
   * Called with any WebGPU validation error, and if the device is lost.
   *
   * Without this, a pipeline that fails validation just draws nothing: the canvas goes quietly
   * blank and there is nothing to go on. Surfacing it into the status bar turns the commonest
   * class of shader and layout mistake into a readable message.
   */
  onError?: (message: string) => void
}

export class Compositor {
  private frame: Frame
  private bindGroupCache = new Map<string, GPUBindGroup>()

  private constructor(frame: Frame) {
    this.frame = frame
  }

  static async create(canvas: HTMLCanvasElement, options: CompositorOptions = {}): Promise<Compositor> {
    if (!('gpu' in navigator) || !navigator.gpu) {
      throw new Error('This build needs WebGPU, which this webview does not have.')
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('No GPU adapter was available.')

    const device = await adapter.requestDevice()
    device.addEventListener('uncapturederror', (event) => {
      const error = event as GPUUncapturedErrorEvent
      options.onError?.(error.error.message)
    })
    void device.lost.then((info) => {
      options.onError?.(`the GPU device was lost: ${info.message || info.reason}`)
    })
    const context = canvas.getContext('webgpu')
    if (!context) throw new Error('The canvas would not give up a WebGPU context.')
    const format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: 'opaque' })

    const module = device.createShaderModule({ code: MODULE_SOURCE, label: 'compositor' })
    // A shader that does not compile takes every pipeline built from it down with it, and the
    // resulting failure is a bare "invalid due to a previous error" with nothing to go on. Reading
    // the compilation info is the only way back to the line that broke.
    void module.getCompilationInfo().then((info) => {
      for (const message of info.messages) {
        if (message.type === 'error') {
          options.onError?.(`shader line ${message.lineNum}:${message.linePos} — ${message.message}`)
        }
      }
    })

    // Every pipeline below is created inside an error scope: a failure there produces an error
    // object rather than an exception, and the actual reason is only reported once, here.
    device.pushErrorScope('validation')
    const emptyLayout = device.createBindGroupLayout({ entries: [], label: 'empty' })
    const compositeLayout = device.createBindGroupLayout({
      label: 'composite',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PARAMS_BYTES },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'non-filtering' } },
      ],
    })
    const displayLayout = device.createBindGroupLayout({
      label: 'display',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: DISPLAY_BYTES } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    })

    const compositePipeline = device.createRenderPipeline({
      label: 'composite',
      layout: device.createPipelineLayout({ bindGroupLayouts: [emptyLayout, compositeLayout] }),
      vertex: { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint: 'fs_composite', targets: [{ format: ACCUM_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    })
    const displayPipeline = device.createRenderPipeline({
      label: 'display',
      layout: device.createPipelineLayout({ bindGroupLayouts: [displayLayout] }),
      vertex: { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint: 'fs_display', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    })
    const flattenPipeline = device.createRenderPipeline({
      label: 'flatten',
      layout: device.createPipelineLayout({ bindGroupLayouts: [emptyLayout, compositeLayout] }),
      vertex: { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint: 'fs_composite', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })

    const adjustLayout = device.createBindGroupLayout({
      label: 'adjust',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: ADJUST_UNIFORM_VECS * 16 },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    })
    const adjustPipeline = device.createRenderPipeline({
      label: 'adjust',
      layout: device.createPipelineLayout({
        // The module's other bindings have to be declared even though this pass does not use them,
        // and an empty layout is the only thing that can sit in their slots.
        bindGroupLayouts: [emptyLayout, emptyLayout, adjustLayout],
      }),
      vertex: { module, entryPoint: 'vs_fullscreen' },
      fragment: { module, entryPoint: 'fs_adjust', targets: [{ format: ACCUM_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    })

    void device.popErrorScope().then((error) => {
      if (error) options.onError?.(`pipeline creation — ${error.message}`)
    })

    const uniformStride = Math.max(256, device.limits.minUniformBufferOffsetAlignment)
    const compositeUniforms = device.createBuffer({
      label: 'composite params',
      size: uniformStride * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    const displayUniform = device.createBuffer({
      label: 'display params',
      size: DISPLAY_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    const adjustUniform = device.createBuffer({
      label: 'adjust params',
      size: uniformStride * ADJUST_UNIFORM_SLOTS,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    const linearSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    const nearestSampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' })

    // A 1×1 transparent texture, so a layer without a mask still has something to bind.
    const dummy = device.createTexture({
      label: 'dummy',
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture({ texture: dummy }, new Uint8Array([0, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1, 1])

    const emptyBindGroup = device.createBindGroup({ layout: emptyLayout, entries: [] })
    const displayBindGroup = device.createBindGroup({
      label: 'display',
      layout: displayLayout,
      entries: [
        { binding: 0, resource: { buffer: displayUniform } },
        { binding: 1, resource: dummy.createView() },
        { binding: 2, resource: linearSampler },
      ],
    })

    const frame: Frame = {
      device,
      context,
      format,
      compositePipeline,
      adjustPipeline,
      adjustLayout,
      adjustUniform,
      adjustSampler: linearSampler,
      luts: new Map(),
      flattenPipeline,
      displayPipeline,
      emptyBindGroup,
      compositeLayout,
      displayLayout,
      displayUniform,
      displayBindGroup,
      compositeUniforms,
      uniformScratch: new Float32Array(uniformStride / 4),
      uniformStride,
      linearSampler,
      nearestSampler,
      dummy,
      accum: null,
      layerTextures: new Map(),
      last: null,
      exportTexture: null,
      exportSize: [0, 0],
      size: [0, 0],
      scratch: new Float32Array(PARAMS_BYTES / 4),
    }
    return new Compositor(frame)
  }

  get device(): GPUDevice {
    return this.frame.device
  }

  /** Resizes the canvas backing store. `width` and `height` are device pixels. */
  resize(width: number, height: number): void {
    const canvas = this.frame.context.canvas as HTMLCanvasElement
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
  }

  /** Allocates the accumulation textures for a document size, if they are not already right. */
  setDocumentSize(width: number, height: number): void {
    const frame = this.frame
    if (frame.accum && frame.size[0] === width && frame.size[1] === height) return
    for (const texture of frame.accum ?? []) texture.destroy()
    const make = () =>
      frame.device.createTexture({
        size: [width, height, 1],
        format: ACCUM_FORMAT,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      })
    frame.accum = [make(), make()]
    frame.size = [width, height]
    this.bindGroupCache.clear()
  }

  private ensureUniformRoom(layers: number): void {
    const frame = this.frame
    const needed = frame.uniformStride * layers
    if (needed <= frame.compositeUniforms.size) return
    frame.compositeUniforms.destroy()
    frame.compositeUniforms = frame.device.createBuffer({
      label: 'composite params',
      size: Math.max(needed, frame.uniformStride * 16),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.bindGroupCache.clear()
  }

  private bindGroupFor(draw: LayerDraw, target: GPUTexture): GPUBindGroup {
    const frame = this.frame
    const key = `${draw.id}|${draw.mask ? 'm' : '-'}|${target === frame.accum![0] ? 0 : 1}`
    const cached = this.bindGroupCache.get(key)
    if (cached) return cached
    const group = frame.device.createBindGroup({
      label: key,
      layout: frame.compositeLayout,
      entries: [
        { binding: 0, resource: { buffer: frame.compositeUniforms, size: PARAMS_BYTES } },
        { binding: 1, resource: (draw.texture ?? frame.dummy).createView() },
        { binding: 2, resource: target.createView() },
        { binding: 3, resource: (draw.mask ?? frame.dummy).createView() },
        { binding: 4, resource: frame.linearSampler },
        { binding: 5, resource: frame.nearestSampler },
      ],
    })
    this.bindGroupCache.set(key, group)
    return group
  }

  /**
   * Composites `draws` (bottom to top) and paints the result.
   *
   * `view` is in device pixels: `panX`/`panY` is where the document's top-left corner sits.
   */
  /**
   * The directions an adjustment's blur runs in.
   *
   * A Gaussian is separable, so it runs twice — across and down — for the price of one multiply
   * instead of a full kernel per pixel. A motion blur runs once, along its angle.
   */
  private static blurDirections(adjustment: LayerAdjustment): [number, number][] {
    if (adjustment.kind === 'Gaussian Blur') {
      return [
        [1, 0],
        [0, 1],
      ]
    }
    if (adjustment.kind === 'Motion Blur') {
      // The angle is counterclockwise from horizontal, and the canvas has y pointing down.
      const radians = ((adjustment.motionAngle ?? 0) * Math.PI) / 180
      return [[Math.cos(radians), -Math.sin(radians)]]
    }
    return [[0, 0]]
  }

  /**
   * The 256 × 3 table for a LUT kind, rebuilt only when the settings behind it change.
   *
   * Rebuilding every frame would put a spline evaluation per byte on the CPU side of a live slider
   * drag; rebuilding never would leave a preview showing the last drag's curve.
   */
  private lutFor(item: AdjustmentDraw): GPUTexture {
    const frame = this.frame
    const table = buildLut(item.adjustment)
    const signature = table
      ? [
          item.adjustment.kind,
          JSON.stringify(item.adjustment.levels ?? null),
          JSON.stringify(item.adjustment.curves ?? null),
          JSON.stringify(item.adjustment.exposureSettings ?? null),
        ].join('|')
      : 'none'

    const cached = frame.luts.get(item.id)
    if (cached && cached.signature === signature) return cached.texture
    cached?.texture.destroy()

    const texture = frame.device.createTexture({
      label: `lut ${item.id}`,
      size: [256, 3, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    if (table) {
      // One channel per row — red, green, blue — with the value in the red component.
      const rgba = new Uint8Array(256 * 3 * 4)
      for (let index = 0; index < 256 * 3; index += 1) {
        rgba[index * 4] = table[index]
        rgba[index * 4 + 3] = 255
      }
      frame.device.queue.writeTexture(
        { texture },
        rgba,
        { bytesPerRow: 256 * 4, rowsPerImage: 3 },
        [256, 3, 1],
      )
    }
    frame.luts.set(item.id, { texture, signature })
    return texture
  }

  /** One adjustment pass: read the accumulation, write the adjusted result to the other one. */
  private runAdjustPass(
    encoder: GPUCommandEncoder,
    item: AdjustmentDraw,
    read: GPUTexture,
    write: GPUTexture,
    direction: [number, number],
    slot: number,
  ): void {
    const frame = this.frame
    const [width, height] = frame.size
    const offset = (slot % ADJUST_UNIFORM_SLOTS) * frame.uniformStride
    frame.device.queue.writeBuffer(
      frame.adjustUniform,
      offset,
      packAdjustment(item.adjustment, item.opacity, width, height, direction, item.mask !== null),
    )
    const bindGroup = frame.device.createBindGroup({
      label: `adjust ${item.id}`,
      layout: frame.adjustLayout,
      entries: [
        { binding: 0, resource: { buffer: frame.adjustUniform, size: ADJUST_UNIFORM_VECS * 16 } },
        { binding: 1, resource: read.createView() },
        { binding: 2, resource: this.lutFor(item).createView() },
        { binding: 3, resource: frame.adjustSampler },
        { binding: 4, resource: (item.mask ?? frame.dummy).createView() },
      ],
    })
    const pass = encoder.beginRenderPass({
      label: `adjust ${item.id}`,
      colorAttachments: [
        {
          view: write.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    })
    pass.setPipeline(frame.adjustPipeline)
    pass.setBindGroup(0, frame.emptyBindGroup)
    pass.setBindGroup(1, frame.emptyBindGroup)
    pass.setBindGroup(2, bindGroup, [offset])
    pass.draw(3)
    pass.end()
  }

  render(items: readonly DrawItem[], view: ViewState): void {
    const frame = this.frame
    if (!frame.accum) return
    const [width, height] = frame.size
    const canvas = frame.context.canvas as HTMLCanvasElement

    const visible = items.filter((item) => item.kind === 'adjustment' || item.texture !== null)
    const layers = visible.filter((item): item is LayerDraw => item.kind === 'layer')
    this.ensureUniformRoom(Math.max(1, layers.length))

    // Pack every layer's uniforms into one buffer, at the dynamic-offset stride.
    const floatsPerLayer = frame.uniformStride / 4
    const scratch = new Float32Array(floatsPerLayer * Math.max(1, layers.length))
    layers.forEach((draw, index) => {
      const base = index * floatsPerLayer
      const mode = Math.max(0, BLEND_MODES.indexOf(draw.blendMode))
      scratch.set([width, height, draw.opacity, mode], base)
      scratch.set(
        [
          draw.transform.origin[0],
          draw.transform.origin[1],
          draw.transform.size[0],
          draw.transform.size[1],
        ],
        base + 4,
      )
      scratch.set(
        [
          (draw.transform.rotation * Math.PI) / 180,
          draw.transform.flipX ? 1 : 0,
          draw.transform.flipY ? 1 : 0,
          draw.mask ? 1 : 0,
        ],
        base + 8,
      )
      scratch.set([draw.transform.sampling === 'Nearest' ? 1 : 0, 0, 0, 0], base + 12)
    })
    if (scratch.length > 0) frame.device.queue.writeBuffer(frame.compositeUniforms, 0, scratch)

    const encoder = frame.device.createCommandEncoder({ label: 'compositor' })
    let [read, write] = frame.accum
    let layerIndex = 0

    const advance = () => {
      const swap = read
      read = write
      write = swap
    }

    let adjustSlot = 0
    for (const item of visible) {
      if (item.kind === 'adjustment') {
        for (const direction of Compositor.blurDirections(item.adjustment)) {
          this.runAdjustPass(encoder, item, read, write, direction, adjustSlot)
          adjustSlot += 1
          advance()
        }
        continue
      }
      const pass = encoder.beginRenderPass({
        label: `layer ${layerIndex}`,
        colorAttachments: [
          {
            view: write.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      })
      pass.setPipeline(frame.compositePipeline)
      pass.setBindGroup(0, frame.emptyBindGroup)
      pass.setBindGroup(1, this.bindGroupFor(item, read), [layerIndex * frame.uniformStride])
      pass.draw(3)
      pass.end()
      advance()
      layerIndex += 1
    }

    frame.device.queue.writeBuffer(
      frame.displayUniform,
      0,
      new Float32Array([canvas.width, canvas.height, view.zoom, 0, view.panX, view.panY, 0, 0, width, height, 0, 0]),
    )

    const display = frame.device.createBindGroup({
      label: 'display',
      layout: frame.displayLayout,
      entries: [
        { binding: 0, resource: { buffer: frame.displayUniform } },
        { binding: 1, resource: read.createView() },
        { binding: 2, resource: view.zoom >= 8 ? frame.nearestSampler : frame.linearSampler },
      ],
    })
    frame.last = read

    const pass = encoder.beginRenderPass({
      label: 'display',
      colorAttachments: [
        {
          view: frame.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0.13, g: 0.13, b: 0.14, a: 1 },
        },
      ],
    })
    pass.setPipeline(frame.displayPipeline)
    pass.setBindGroup(0, display)
    pass.draw(3)
    pass.end()

    frame.device.queue.submit([encoder.finish()])
  }

  /**
   * Uploads decoded pixels as a layer texture, or updates the region already there.
   *
   * A brush stroke changes a small rectangle per dab, and re-uploading the whole layer for each
   * one would spend more on the bus than on the drawing. `region` is in the source's own pixels.
   *
   * `RENDER_ATTACHMENT` is not decoration: `copyExternalImageToTexture` runs a render pass
   * internally and refuses a destination that is not renderable, so a texture without it stays
   * empty and every layer composites to nothing — silently, unless an error scope is watching.
   */
  setLayerTexture(
    key: string,
    source: GPUCopyExternalImageSource,
    width: number,
    height: number,
    region?: { x: number; y: number; width: number; height: number },
  ): GPUTexture {
    const frame = this.frame
    let texture = frame.layerTextures.get(key)
    if (!texture || texture.width !== width || texture.height !== height) {
      texture?.destroy()
      texture = frame.device.createTexture({
        label: key,
        size: [width, height, 1],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      })
      frame.layerTextures.set(key, texture)
      this.bindGroupCache.clear()
    }

    const area = region
      ? {
          x: Math.max(0, Math.floor(region.x)),
          y: Math.max(0, Math.floor(region.y)),
          width: Math.min(width, Math.ceil(region.x + region.width)) - Math.max(0, Math.floor(region.x)),
          height: Math.min(height, Math.ceil(region.y + region.height)) - Math.max(0, Math.floor(region.y)),
        }
      : { x: 0, y: 0, width, height }
    if (area.width <= 0 || area.height <= 0) return texture

    frame.device.queue.copyExternalImageToTexture(
      { source, origin: { x: area.x, y: area.y } },
      { texture, origin: { x: area.x, y: area.y } },
      [area.width, area.height],
    )
    return texture
  }

  /** Uploads a whole layer at once. */
  upload(key: string, source: GPUCopyExternalImageSource, width: number, height: number): GPUTexture {
    return this.setLayerTexture(key, source, width, height)
  }

  disposeLayerTexture(key: string): void {
    this.frame.layerTextures.get(key)?.destroy()
    this.frame.layerTextures.delete(key)
    this.bindGroupCache.clear()
  }

  /**
   * Flattens the last composited frame into straight-alpha 8-bit RGBA, for export.
   *
   * The accumulation is `rgba16float` and premultiplied; a PNG wants 8-bit straight alpha. The
   * flatten runs as one more composite pass — a full-canvas Normal layer at 1:1, nearest sampling —
   * into an `rgba8unorm` target, which is then copied out. It is the only time a frame leaves the
   * GPU, and it only runs when somebody asks for a file.
   */
  async flatten(): Promise<{ width: number; height: number; data: Uint8ClampedArray } | null> {
    const frame = this.frame
    if (!frame.last || !frame.accum) return null
    const [width, height] = frame.size
    const device = frame.device

    if (frame.exportTexture === null || frame.exportSize[0] !== width || frame.exportSize[1] !== height) {
      frame.exportTexture?.destroy()
      frame.exportTexture = device.createTexture({
        label: 'export',
        size: [width, height, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      })
      frame.exportSize = [width, height]
    }

    const copyParams = new Float32Array(PARAMS_BYTES / 4)
    copyParams.set([width, height, 1, 0], 0)
    copyParams.set([0, 0, width, height], 4)
    copyParams.set([0, 0, 0, 0], 8)
    copyParams.set([1, 0, 0, 0], 12)
    device.queue.writeBuffer(frame.compositeUniforms, 0, copyParams)

    const copyBindGroup = device.createBindGroup({
      label: 'flatten',
      layout: frame.compositeLayout,
      entries: [
        { binding: 0, resource: { buffer: frame.compositeUniforms, size: PARAMS_BYTES } },
        { binding: 1, resource: frame.last.createView() },
        { binding: 2, resource: frame.dummy.createView() },
        { binding: 3, resource: frame.dummy.createView() },
        { binding: 4, resource: frame.linearSampler },
        { binding: 5, resource: frame.nearestSampler },
      ],
    })

    // copyTextureToBuffer wants each row to start on a 256-byte boundary.
    const padded = Math.ceil((width * 4) / 256) * 256
    const buffer = device.createBuffer({
      label: 'readback',
      size: padded * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })

    const encoder = device.createCommandEncoder({ label: 'flatten' })
    const pass = encoder.beginRenderPass({
      label: 'flatten',
      colorAttachments: [
        {
          view: frame.exportTexture.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    })
    pass.setPipeline(frame.flattenPipeline)
    pass.setBindGroup(0, frame.emptyBindGroup)
    pass.setBindGroup(1, copyBindGroup, [0])
    pass.draw(3)
    pass.end()
    encoder.copyTextureToBuffer(
      { texture: frame.exportTexture },
      { buffer, bytesPerRow: padded, rowsPerImage: height },
      [width, height, 1],
    )
    device.queue.submit([encoder.finish()])

    await buffer.mapAsync(GPUMapMode.READ)
    const source = new Uint8Array(buffer.getMappedRange())
    const data = new Uint8ClampedArray(width * height * 4)
    for (let row = 0; row < height; row += 1) {
      const from = row * padded
      for (let column = 0; column < width; column += 1) {
        const a = source[from + column * 4 + 3]
        const alpha = a / 255
        const target = (row * width + column) * 4
        if (alpha === 0) {
          data[target] = 0
          data[target + 1] = 0
          data[target + 2] = 0
          data[target + 3] = 0
        } else {
          // The composite is premultiplied; a PNG is not.
          data[target] = source[from + column * 4] / alpha
          data[target + 1] = source[from + column * 4 + 1] / alpha
          data[target + 2] = source[from + column * 4 + 2] / alpha
          data[target + 3] = a
        }
      }
    }
    buffer.unmap()
    buffer.destroy()
    return { width, height, data }
  }

  destroy(): void {
    for (const texture of this.frame.accum ?? []) texture.destroy()
    this.frame.accum = null
    for (const entry of this.frame.luts.values()) entry.texture.destroy()
    this.frame.luts.clear()
    this.frame.adjustUniform.destroy()
    for (const texture of this.frame.layerTextures.values()) texture.destroy()
    this.frame.layerTextures.clear()
    this.frame.exportTexture?.destroy()
    this.frame.compositeUniforms.destroy()
    this.frame.displayUniform.destroy()
    this.frame.dummy.destroy()
    this.bindGroupCache.clear()
  }
}
