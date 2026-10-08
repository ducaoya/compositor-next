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

## Testing

```sh
pnpm check
```

- `crates/core` — the format: what loads, what is refused, what survives a round-trip, and the
  Node-written sample project.
- `crates/shaders` — the WGSL parses, validates, and still matches the blend-mode and
  adjustment-kind lists.
- `web` — the blend maths (including the sRGB-not-linear-light check), the adjustment maths, the
  selection and selection-mask maths, the layer tree, undo, the layer operations, and the i18n
  tables.

Behaviour that only a GPU can show was checked by driving the real interface in headless Chrome:
every blend mode, every adjustment kind, the brush, the selections, the transform handles, and mask
painting. `scripts/dev-browser.mjs` sets that up.
