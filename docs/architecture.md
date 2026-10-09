# How it works

Engineering notes for anyone changing the inside of this editor. The
[README](../README.md) covers what it does and how to build it; this covers why the parts are put
together the way they are.

## How a frame is drawn

Layers are composited one at a time into an offscreen `rgba16float` accumulation texture, the same
way the original composites into a Core Graphics context. Two accumulations are ping-ponged because
a render pass cannot read its own target. An adjustment layer takes the same path: it is one more
pass over the accumulation rather than something that draws, which is why it sits in the same draw
list as the layers — order is what decides what an adjustment applies to.

Everything stays on the GPU between frames: a pan or a zoom only changes a display uniform. Layer
pixels are uploaded once, when a layer is decoded, and never cross the process boundary again —
**nothing in the frame path goes through IPC**. Rust only opens and saves projects.

The accumulation is `rgba16float` so that repeated blending does not quantize to eight bits, and the
blend maths runs in **sRGB-encoded values, not linear light**, matching Photoshop and the original.
`web/src/render/compositor.wgsl` says so in a comment because it is the single easiest thing to get
wrong.

### Painting

Painting happens on the CPU, in an `OffscreenCanvas` per surface, because that is what a brush tip
is: a radial gradient stamped along a path. Painting straight into the GPU texture would mean
implementing brush tips, blending and undo against the GPU for no gain.

Only the rectangle a stroke touched is re-uploaded, so a 4,000 × 4,000 layer costs a few hundred
kilobytes per dab rather than sixty-four megabytes. Layers and masks each get a surface, and clicking
a thumbnail in the Layers panel aims the tools at one or the other.

A canvas clip takes a path, and a feathered selection is not a path, so a coverage-mask selection
goes through the brush differently: the tip is drawn on a shared scratch, cut down by the mask with
`destination-in`, then composited. Erasing uses the same path with `destination-out`, so a soft
selection erases softly.

### The two copies of the maths

The blend and adjustment maths lives in two places that are kept in step by construction:

| | |
|---|---|
| `web/src/model/blend.ts`, `web/src/model/adjustments.ts` | TypeScript, used by the tests and by the data the shader reads |
| `web/src/render/compositor.wgsl`, `web/src/render/adjust.wgsl` | WGSL, used by the GPU |

A Rust test parses the **real** shader files with `naga` and checks that the blend-mode cases and the
adjustment-kind numbers still line up with the lists the TypeScript packs into the uniform. A drift
there would render Levels as Curves, silently — so the shader is verified in CI without a GPU.

Two shader files are concatenated into one module, because WGSL has no `#include`. The order matters:
`compositor.wgsl` declares the adjustment uniform and its bindings, and `adjust.wgsl` uses them.

## Saving

Saving is three calls so that image bytes never travel as JSON:

1. `begin_save` makes a staging folder beside the target and returns a session id.
2. `write_asset` writes one PNG, its bytes as a raw IPC body. A layer that was only opened is
   *linked* from its existing file rather than re-sent, and only surfaces the brush actually touched
   are re-encoded.
3. `commit_save` validates the staged package and swaps it in.

The swap is a rename, so a reader — including the original app, if it is watching — sees either the
old project or the new one, never a half-written one. `staging_directory` sweeps any staging folder
a crashed run left behind.

A layer mask is stored as 8-bit grayscale PNG with no alpha, which `canvas.convertToBlob` cannot
produce, so masks are encoded by hand in `web/src/render/png.ts`. Only what a mask needs: colour
type 0, one IDAT, with `CompressionStream('deflate')` doing the deflate because PNG holds a zlib
stream and that is what the platform produces.

Rust never builds user-facing prose. `ProjectError` carries a translation key and the values for its
placeholders, and the language pack says it — otherwise every error message would be English
whichever language the interface was in.

## GPU failures are silent by default

`Compositor.create` reads the shader's compilation info and wraps pipeline creation in a validation
error scope, and the session keeps **every** WebGPU diagnostic rather than the last. This is not
belt-and-braces: a shader that fails to compile takes every pipeline built from it down, and the
failure that reaches `queue.submit` is a bare "invalid due to a previous error" with nothing to go
on. A cascade's first message is the one that explains it, and the last one is noise.

Three bugs found by driving the real interface, none of which any test could have caught:

- Chrome's WGSL parser requires explicit parentheses when `*` and `^` appear together, which `naga`
  accepts. The shader compiled in CI and failed in the browser.
- Two blur passes encoded into one submit shared a uniform buffer, and both `writeBuffer` calls land
  before the submit — so a two-pass Gaussian blurred one way twice. Adjustment uniforms now use a
  dynamic offset per pass, the same arrangement the composite uses.
- The browser preview's `openProject` handed back the same manifest object, so reopening a document
  after editing it showed the edits still applied.

## Retouching

`web/src/render/retouch/` holds the kernels — spot healing and content-aware fill (ports of the
reference's `HealPixels.c` and `ContentFill.c`, membrane solve, patch search and all), the separable
blur and the unsharp mask, the smudge dab, Add Noise, and the dodge/burn/sponge tone curves. They are
pure functions over typed arrays with no canvas and no GPU, so a 259-line C membrane solver is tested
in a node process. `web/src/render/filters/` is the same idea for Vignette, Bloom, Tonal Contrast,
Lens Correction and Noise.

`web/src/render/retouchStroke.ts` is the state machine around them, and one decision there decides
how every one of these tools behaves: **the sample is taken when the stroke starts, not per dab.** A
clone that re-read its source every dab copies its own output, which paints a blur of itself down the
stroke; a blur that re-reads turns a long drag into a smear of a smear. Clone, Blur and Sharpen take
a sample and composite it through the tip; Smudge and Spot Healing work on a copy of the layer's
pixels; Dodge, Burn and Sponge read, adjust and write back, because they *do* build up. Spot Healing
accumulates coverage and heals once at the end, since healing dab by dab would have each dab looking
at what the last one invented.

## The two downsamples, and the mip chains

A frame shrinks an image twice, and both were single-level samples until recently. A layer is placed
at the document's size while its own pixels may be larger, so the composite pass samples a shrinking
texture; then the accumulation is at document resolution while the screen may be a quarter of it, so
the display pass does it again. Both now carry a full mip chain, built by one fullscreen pass per
level reading the level above through a linear sampler — a bilinear fetch at the centre of the
two-by-two block a texel covers *is* the box average, so the sampler does the reduction.

The level is chosen from the ratio of the two sizes, and it is exactly zero when nothing is being
shrunk. That last part is not cosmetic: a level of 0.001 blends in a thousandth of the level below,
which is invisible on screen and enough to move a pixel by a byte, and an exact assertion that
regresses by a byte is the kind of test failure that costs an afternoon.

## Importing

`web/src/io/` is where a file becomes pixels. The webview decodes what a browser decodes, and a
browser refuses two formats an editor needs, so SVG is rasterised through an `<img>` (the one place a
vector becomes pixels) and TIFF has a reader written from the specification — strips only, no
compression, PackBits, LZW with the early-change rule, and Deflate through the platform's
`DecompressionStream`, over greyscale, RGB, RGBA, palette and CMYK at 1, 2, 4, 8 and 16 bits.

Everything outside that is refused *by name*: BigTIFF, tiles, JPEG compression, YCbCr, floating-point
samples, predictor 3. So are RAW (the only pure-Rust decoder is LGPL-2.1 and this project is MIT) and
HEIC (the decoder is the platform's and reaching it from Rust is not done). A file that opens to a
wrong-looking picture is worse than one that says why it cannot be opened.

## Testing

```sh
pnpm check
```

- `crates/core` — the format: what loads, what is refused, what survives a round-trip, and the
  Node-written sample project.
- `crates/shaders` — the WGSL parses, validates, and still matches the blend-mode and
  adjustment-kind lists.
- `web` — the blend maths (including the sRGB-not-linear-light check), the adjustment maths, the
  selection and selection-mask maths, the layer tree, undo, the layer operations, the retouch and
  filter kernels, the TIFF reader, the version comparison, and the i18n tables.

Behaviour that only a GPU can show was checked by driving the real interface in headless Chrome:
every blend mode, every adjustment kind, the brush, the retouching tools, the filters, the
selections, the transform handles, and mask painting. `scripts/dev-browser.mjs` sets that up, and
`scripts/gpu-test.mjs` runs the cases.

There are two readbacks and the difference matters. `renderAndRead` reads the accumulation, which is
always at document resolution — it is the document, and a case about what a layer looks like uses it.
`renderAndReadView` snapshots the canvas as shown, which is the only way to see the zoom, the pan, or
the mip level a shrunken frame is sampled at. The case that measures moiré at a quarter size needs
the second one, and measuring it with the first returned the same number at every zoom — which is how
it was found out that the fixture had no periodicity to measure at all.

Four bugs found by driving the real interface, none of which a unit test could have caught:

- Chrome's WGSL parser requires explicit parentheses when `*` and `^` appear together, which `naga`
  accepts. The shader compiled in CI and failed in the browser.
- Two blur passes encoded into one submit shared a uniform buffer, and both `writeBuffer` calls land
  before the submit — so a two-pass Gaussian blurred one way twice. Adjustment uniforms now use a
  dynamic offset per pass, the same arrangement the composite uses.
- The browser preview's `openProject` handed back the same manifest object, so reopening a document
  after editing it showed the edits still applied.
- The moment the accumulation gained a mip chain, every pass writing into it was dropped in silence:
  a texture view made with no arguments covers every level, and WebGPU refuses one as a render
  attachment. The GPU cases went from 20/20 to 0/22, which is the whole argument for having them.
