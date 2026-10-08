# Compositor (cross-platform)

A cross-platform image editor for compositing and photo work, built from the design of
[**robbietilton/Compositor**](https://github.com/robbietilton/Compositor) — a free, open-source
Photoshop alternative for macOS, written in Swift.

That project is the inspiration and the reference for everything here. This one is a from-scratch
reimplementation for Windows, macOS and Linux, so that the same editor exists off the Mac: Tauri 2 +
Vue 3 + WebGPU + Rust instead of AppKit + Core Image + Metal.

It reads and writes the original's `.comp` project format, versions 1–11, so a project saved in
either editor opens in the other.

**Licence: MIT.** See [Attribution and licence](#attribution-and-licence) — this is a derivative
work, and the original's notice is preserved in [LICENSE](LICENSE).

---

## What works today

### Projects and format

- **`.comp` projects, read and written** — the original's folder-of-PNGs format, versions 1–11,
  including folders, layer masks, clipping masks, guides, and per-layer opacity and blend mode. A
  project saved here opens there, and the other way round.
- **Importing** — a file picker or a drop onto the canvas, one layer per image.
- **Export a flattened PNG.**

### Compositing

- **All 24 blend modes**, in sRGB exactly as Photoshop does it, not in linear light.
- **Adjustment layers, all twelve** — Hue/Saturation, Levels, Curves, Exposure, Gradient Map,
  Grain, Invert, Black & White, Color Balance, Gaussian Blur, Motion Blur and Add Noise, each with
  its own editor. An adjustment changes everything composited below it, mask and opacity included.
- **Layer masks** — read, written, composited, honoured by adjustment layers, and paintable.
- **Folders** with their own opacity, clipping masks, and inherited visibility.
- **Undo and redo** over whole-document snapshots, one step per gesture.

### Painting and selections

- **Brush and eraser** with size, hardness, opacity and flow, stroke smoothing, and a live tip
  outline.
- **Selections** — rectangle, ellipse and freehand lasso, the Magic Wand, Select All, Deselect and
  Inverse.
- **Feather, Expand and Contract** on a selection, and painting is clipped to it — a soft selection
  erases softly.
- **The Move tool** — drag with snapping to the canvas, its centre and the other layers' edges,
  with the snapped lines drawn as guides. Its eight handles scale and the handle above the top edge
  rotates.

### The application

- **Photoshop's layout and dark theme** — a menu bar, an options bar for the current tool, the tool
  rail down the left, the document with its tab, the Layers and Properties panels on the right, and
  the status bar along the bottom.
- **Languages** — English and Simplified Chinese built in, and any number of user-installed language
  packs. See [docs/language-packs.md](docs/language-packs.md).

## What is not here yet

- **Layer effects** — stroke, drop shadow, glow and colour overlay. The file keeps every setting;
  the compositor does not render them yet.
- **The per-range bands in Hue/Saturation.** The master hue, saturation and lightness apply; the six
  colour-range bands do not.
- **PSD import, camera RAW, and selecting a subject.** The original uses Vision for the last of
  these; this will use an ONNX segmentation model.
- **Opening a `.comp` by double-clicking it** in the file manager.
- **Anything to do with a document you would not want to lose.** There is no autosave and no crash
  recovery.

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

Requirements: Rust (the MSVC toolchain on Windows), Node 22+, pnpm, and the WebView2 runtime.

`scripts/dev-browser.mjs` starts a **headless** Chrome with remote debugging and a software Vulkan
device, which is how every interface change in this repository was checked. It stays out of the way:
a debugging browser that takes the foreground on every navigation is one nobody runs.

## Layout

```
crates/
  core/       the .comp format: manifest schema, validation, package I/O
  shaders/    parse- and validation-checks for the WGSL, so a shader typo fails a test
src-tauri/    the desktop shell and the commands the webview may call
web/          the frontend
  src/model/      document, blend, adjustments, selections, tools — pure and testable
  src/render/     the WebGPU compositor, the WGSL, the brush, the PNG encoder
  src/state/      the session store and the backend boundary
  src/i18n/       the message tables and the language-pack machinery
  src/components/ the Vue interface
examples/     sample.comp, an example language pack
docs/         language packs
```

## How a frame is drawn

Layers are composited one at a time into an offscreen `rgba16float` accumulation texture, the same
way the original composites into a Core Graphics context. Two accumulations are ping-ponged because
a render pass cannot read its own target. An adjustment layer takes the same path: it is one more
pass over the accumulation rather than something that draws.

Layer pixels are uploaded to the GPU once, when a layer is decoded, and never cross the process
boundary again — **nothing in the frame path goes through IPC**. Rust only opens and saves projects.

Painting happens on the CPU, in an `OffscreenCanvas` per surface, because that is what a brush tip
is: a radial gradient stamped along a path. Only the rectangle a stroke touched is re-uploaded, so a
4,000 × 4,000 layer costs a few hundred kilobytes per dab rather than sixty-four megabytes. Layers
and masks each get a surface; clicking a thumbnail aims the tools at one or the other.

The blend and adjustment maths lives in two places that are kept in step by construction:
`web/src/model/*.ts` (TypeScript, used by the tests) and `web/src/render/*.wgsl` (WGSL, used by the
GPU). A Rust test parses the real shader with `naga` and checks that its blend-mode cases and
adjustment-kind numbers still line up, so the shader is verified in CI without a GPU.

## Saving

Saving is three calls so that image bytes never travel as JSON:

1. `begin_save` makes a staging folder beside the target and returns a session id.
2. `write_asset` writes one PNG, its bytes as a raw IPC body. A layer that was only opened is
   *linked* from its existing file rather than re-sent, and only surfaces the brush actually
   touched are re-encoded.
3. `commit_save` validates the staged package and swaps it in.

The swap is a rename, so a reader — including the original app, if it is watching — sees either the
old project or the new one, never a half-written one.

A mask is stored as 8-bit grayscale PNG with no alpha, which `canvas.convertToBlob` cannot produce,
so masks are encoded by hand in `web/src/render/png.ts`.

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
  tables (key parity between languages, placeholder parity, pack validation).

Behaviour that only a GPU can show was checked by driving the real interface in headless Chrome:
every blend mode, every adjustment kind, the brush, the selections, the transform handles, and mask
painting. Several bugs were found this way and could not have been found by the tests — Chrome's
WGSL parser rejecting an expression `naga` accepts, two blur passes sharing one uniform buffer, and
a preview backend handing back the same document object after an edit.

## Attribution and licence

**This project is a derivative work of
[robbietilton/Compositor](https://github.com/robbietilton/Compositor)**, which is MIT licensed,
Copyright (c) 2026 Wonder Assembly LLC. Its notice is reproduced in [LICENSE](LICENSE), as its terms
require.

Nothing here is a copy of that project's source: this is a different language, a different UI
toolkit and a different rendering stack. What was derived from it is the design:

| Derived | Where it came from |
|---|---|
| The `.comp` format — schema, version history, validation rules, limits | `docs/project-format.md`, `ProjectStore.swift` |
| The 24 blend-mode formulas and the sRGB-not-linear-light choice | `SeparableBlend.swift`, `LayerAppearance.swift` |
| The twelve adjustment formulas — Levels, the shape-preserving Curves interpolation, Exposure in linear light, the Black & White channel mixing, Colour Balance's tonal weights, the gradient-map and grain hashes | `Levels.swift`, `Curves.swift`, `ImageAdjustments.swift`, `AdjustPixels.c` |
| The compositing model — pass-through folders, folder opacity multiplying into children, clipping masks as alpha links, adjustments affecting what is below them | `ImageExporter.swift`, `LayerGroups.swift` |
| Hue/Saturation's HSL maths and Photoshop's multiplicative saturation | `HueSaturation.swift` |
| The Photoshop interface this imitates | The original app, and Photoshop itself |

If you are the author of the original and would like anything here worded or attributed differently,
please open an issue.

This project is released under the **MIT License**. Replace the placeholder copyright line in
[LICENSE](LICENSE) with your own name or entity before publishing.
