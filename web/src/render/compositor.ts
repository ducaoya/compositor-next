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
import { BLEND_MODES, type BlendModeName, type Transform } from '../model/types'

const ACCUM_FORMAT: GPUTextureFormat = 'rgba16float'
/** Bytes per layer of composite uniforms; also the dynamic-offset stride. */
const PARAMS_BYTES = 64
const DISPLAY_BYTES = 48

export interface LayerDraw {
  id: string
  /** Null for a layer with no pixels yet: it draws nothing. */
  texture: GPUTexture | null
  mask: GPUTexture | null
  transform: Transform
  /** Already multiplied through every enclosing folder. */
  opacity: number
  blendMode: BlendModeName
}

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

    const module = device.createShaderModule({ code: shaderSource, label: 'compositor' })

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
  render(draws: readonly LayerDraw[], view: ViewState): void {
    const frame = this.frame
    if (!frame.accum) return
    const [width, height] = frame.size
    const canvas = frame.context.canvas as HTMLCanvasElement

    const visible = draws.filter((draw) => draw.texture !== null)
    this.ensureUniformRoom(Math.max(1, visible.length))

    // Pack every layer's uniforms into one buffer, at the dynamic-offset stride.
    const floatsPerLayer = frame.uniformStride / 4
    const scratch = new Float32Array(floatsPerLayer * Math.max(1, visible.length))
    visible.forEach((draw, index) => {
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

    for (let index = 0; index < visible.length; index += 1) {
      const pass = encoder.beginRenderPass({
        label: `layer ${index}`,
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
      pass.setBindGroup(1, this.bindGroupFor(visible[index], read), [index * frame.uniformStride])
      pass.draw(3)
      pass.end()
      const swap = read
      read = write
      write = swap
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
   * Uploads decoded pixels as a layer texture. Replaces any texture already held for `id`.
   *
   * `RENDER_ATTACHMENT` is not decoration: `copyExternalImageToTexture` runs a render pass
   * internally and refuses a destination that is not renderable, so a texture without it stays
   * empty and every layer composites to nothing — silently, unless an error scope is watching.
   */
  upload(id: string, source: GPUCopyExternalImageSource, width: number, height: number): GPUTexture {
    const frame = this.frame
    const texture = frame.device.createTexture({
      label: id,
      size: [width, height, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    })
    frame.device.queue.copyExternalImageToTexture({ source }, { texture }, [width, height])
    this.bindGroupCache.clear()
    return texture
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
    this.frame.exportTexture?.destroy()
    this.frame.compositeUniforms.destroy()
    this.frame.displayUniform.destroy()
    this.frame.dummy.destroy()
    this.bindGroupCache.clear()
  }
}
