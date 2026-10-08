# Compositor (cross-platform)

A from-scratch, cross-platform rebuild of [robbietilton/Compositor](https://github.com/robbietilton/Compositor)
— a free image editor for compositing and photo work. The original is a macOS app: Swift, SwiftUI,
AppKit, Core Graphics, Core Image, Metal, Vision. This one is Tauri 2 + Vue 3 + WebGPU + Rust, and
runs on Windows, macOS and Linux.

It is a work in progress, not a finished editor. What is here now is the format contract, the
compositing core and the shell around them.

## What works today

- **`.comp` projects, read and written** — the same folder-of-PNGs format the macOS app uses,
  versions 1–11, including folders, layer masks, clipping masks, guides and per-layer opacity and
  blend mode. A project saved here opens there and the other way round.
- **All 24 blend modes**, composited in sRGB exactly as Photoshop does, not in linear light.
- **The canvas** — GPU compositing, pan, zoom, fit, a pixel-accurate checkerboard, guides.
- **The layer stack** — selection, reordering by drag, grouping, visibility, nesting, renaming,
  inherited folder opacity.
- **Properties** — blend mode, opacity, transform, sampling, flips, clipping masks, mask enable.
- **Undo and redo** over whole-document snapshots.
- **Export a flattened PNG.**

## What is not here yet

- Painting, selections, gradients, shapes, text, crop.
- Adjustment layers and layer effects. They are **read and written faithfully** — the file keeps
  every setting — but the compositor does not render them yet.
- PSD import, camera RAW, subject selection. The macOS app uses Vision for the last two; this will
  use an ONNX segmentation model.
- Files opened from the OS (double-click a `.comp`).
- Anything to do with a real document you would not want to lose. There is no autosave and no
  crash recovery.

## Quick start

```sh
pnpm install
pnpm app          # the desktop window
```

Or run the frontend alone in a browser, which loads a demo document so the canvas and the blend
modes can be worked on without the desktop shell:

```sh
pnpm dev
```

Other scripts:

```sh
pnpm check        # every Rust and TypeScript test
pnpm build        # the frontend bundle
node scripts/make-sample-comp.mjs   # regenerate examples/sample.comp
```

Requirements: Rust (MSVC toolchain on Windows), Node 22+, pnpm, and the WebView2 runtime.

## Layout

```
crates/
  core/       the .comp format: manifest schema, validation, package I/O
  shaders/    parse- and validation-checks for the WGSL, so a shader typo fails a test
src-tauri/    the desktop shell and the commands the webview may call
web/          the frontend: document model, WebGPU compositor, Vue UI
examples/     sample.comp, written by scripts/make-sample-comp.mjs
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

## Testing

```sh
pnpm check
```

- `crates/core` — the format: what loads, what is refused, what survives a round-trip, and the
  Node-written sample project.
- `crates/shaders` — the WGSL parses, validates, and still matches the blend-mode list.
- `web` — the blend maths (including the sRGB-not-linear-light check), the layer tree, undo, the
  layer operations.

## Licence

MIT, as the original is.
