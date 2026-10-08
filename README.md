# Compositor (cross-platform)

A from-scratch, cross-platform rebuild of [robbietilton/Compositor](https://github.com/robbietilton/Compositor)
— a free image editor for compositing and photo work. The original is a macOS app: Swift, SwiftUI,
AppKit, Core Graphics, Core Image, Metal, Vision. This one is Tauri 2 + Vue 3 + WebGPU + Rust, and
runs on Windows, macOS and Linux.

It is a work in progress, not a finished editor. What is here now is the format contract, the
compositing core, painting, and the shell around them.

## What works today

- **`.comp` projects, read and written** — the same folder-of-PNGs format the macOS app uses,
  versions 1–11, including folders, layer masks, clipping masks, guides and per-layer opacity and
  blend mode. A project saved here opens there and the other way round.
- **All 24 blend modes**, composited in sRGB exactly as Photoshop does, not in linear light.
- **The canvas** — GPU compositing, pan, zoom, fit, a pixel-accurate checkerboard, guides.
- **Painting** — brush and eraser with size, hardness, opacity and flow, stroke smoothing, and a
  live tip outline. Strokes upload only the rectangle they touched.
- **Selections** — rectangle and ellipse marquee with marching ants, Select All, Deselect, and
  Inverse. Painting and filling are clipped to the selection.
- **The Move tool** — drag a layer, Shift to lock an axis, and snapping to the canvas, its centre
  and the other layers' edges and centres, with the snapped lines drawn as guides.
- **The layer stack** — selection, reordering by drag, grouping, visibility, nesting, renaming,
  inherited folder opacity.
- **Properties** — blend mode, opacity, transform, sampling, flips, clipping masks, mask enable.
- **Undo and redo** over whole-document snapshots, one step per gesture.
- **Importing** — a file picker or a drop onto the canvas, one layer per image.
- **Export a flattened PNG.**
- **Languages** — English and Simplified Chinese built in, and any number of user-installed
  language packs. See [docs/language-packs.md](docs/language-packs.md).

## What is not here yet

- Lasso, magic wand, crop, gradients, shapes, text.
- Adjustment layers and layer effects. They are **read and written faithfully** — the file keeps
  every setting — but the compositor does not render them yet. The same goes for layer masks: they
  are read, written and composited, but not yet paintable.
- Selecting a subject, camera RAW, PSD import. The macOS app uses Vision for the first; this will
  use an ONNX segmentation model.
- Opening a `.comp` by double-clicking it in the OS.
- Anything to do with a document you would not want to lose. There is no autosave and no crash
  recovery.

The interface follows Photoshop's layout and dark theme: a menu bar, an options bar for the current
tool, the tool rail down the left, the document with its tab, and the Layers and Properties panels
on the right.

## Quick start

```sh
pnpm install
pnpm app          # the desktop window
```

Or run the frontend alone in a browser, which loads a demo document so the canvas, the brush and
the blend modes can be worked on without the desktop shell:

```sh
pnpm dev
```

Other scripts:

```sh
pnpm check        # every Rust and TypeScript test
pnpm build        # the frontend bundle
node scripts/make-sample-comp.mjs      # regenerate examples/sample.comp
node scripts/dev-browser.mjs           # headless Chrome with WebGPU, for scripted checks
```

Requirements: Rust (MSVC toolchain on Windows), Node 22+, pnpm, and the WebView2 runtime.

`scripts/dev-browser.mjs` starts a **headless** Chrome with remote debugging and a software Vulkan
device, which is what the screenshots and scripted checks in this repository were made with. It
stays out of the way: a debugging browser that takes the foreground on every navigation is one
nobody runs.

## Layout

```
crates/
  core/       the .comp format: manifest schema, validation, package I/O
  shaders/    parse- and validation-checks for the WGSL, so a shader typo fails a test
src-tauri/    the desktop shell and the commands the webview may call
web/          the frontend: document model, WebGPU compositor, painting, Vue UI
  src/i18n/   the message tables and the language-pack machinery
examples/     sample.comp and an example language pack
docs/         language packs
```

**`crates/core` is the compatibility contract.** Its schema mirrors the original's Swift `Codable`
synthesis exactly and its validator mirrors the original's rule for rule, version gating included.
Two details are easy to get wrong and are pinned by tests: points encode as arrays
(`"origin": [0, 0]`, not `{"x": 0}`), and UUIDs encode uppercase.

## How a frame is drawn

Layers are composited one at a time into an offscreen `rgba16float` accumulation texture, the same
way the original composites into a Core Graphics context. Two accumulations are ping-ponged because
a render pass cannot read its own target. Layer pixels are uploaded to the GPU once, when a layer
is decoded, and never cross the process boundary again — **nothing in the frame path goes through
IPC**. Rust only opens and saves projects.

Painting happens on the CPU, in an `OffscreenCanvas` per layer, because that is what a brush tip is:
a radial gradient stamped along a path. Only the rectangle a stroke touched is re-uploaded, so a
4,000 × 4,000 layer costs a few hundred kilobytes per dab rather than sixty-four megabytes.

The blend maths lives in two places that are kept in step by construction:
`web/src/model/blend.ts` (TypeScript, used by the tests) and `web/src/render/compositor.wgsl`
(WGSL, used by the GPU). A Rust test parses the real shader with `naga` and checks that its
blend-mode cases still line up, so the shader is verified in CI without a GPU.

## Saving

Saving is three calls so that image bytes never travel as JSON:

1. `begin_save` makes a staging folder beside the target and returns a session id.
2. `write_asset` writes one PNG, its bytes as a raw IPC body. A layer that was only opened is
   *linked* from its existing file rather than re-sent.
3. `commit_save` validates the staged package and swaps it in.

The swap is a rename, so a reader — including the other app, if it is watching — sees either the old
project or the new one, never a half-written one.

## Languages

English is the default and the fallback. Simplified Chinese ships with the app. Anything else is a
JSON file: **Edit › Language › Install Language Pack…**, or drop a file into the language folder and
reload. A pack may translate as much or as little as it likes — an untranslated key reads in
English rather than showing a key name.

Rust never builds user-facing prose: it returns an error *key* and the values for its placeholders,
and the language pack says it. Without that, every error message would be English whichever language
the interface was in.

See [docs/language-packs.md](docs/language-packs.md).

## Testing

```sh
pnpm check
```

- `crates/core` — the format: what loads, what is refused, what survives a round-trip, and the
  Node-written sample project.
- `crates/shaders` — the WGSL parses, validates, and still matches the blend-mode list.
- `web` — the blend maths (including the sRGB-not-linear-light check), the layer tree, undo, the
  layer operations, and the i18n tables (key parity between languages, placeholder parity, pack
  validation).

## Licence

MIT, as the original is.
