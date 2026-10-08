# Compositor (cross-platform)

**English** · [简体中文](README.zh-CN.md)

A cross-platform image editor for compositing and photo work, built from the design of
[robbietilton/Compositor](https://github.com/robbietilton/Compositor) — a free, open-source
Photoshop alternative for macOS, written in Swift.

That project is the inspiration and the reference for everything here. This one is a from-scratch
reimplementation for Windows, macOS and Linux, so that the same editor exists off the Mac: Tauri 2 +
Vue 3 + WebGPU + Rust instead of AppKit + Core Image + Metal.

It reads and writes the original's `.comp` project format, versions 1–11, so a project saved in
either editor opens in the other.

**Licence: MIT.** This is a derivative work; the original's notice is preserved in
[NOTICE](NOTICE). See [Attribution and licence](#attribution-and-licence).

## What it does

- **`.comp` projects, read and written** — folders, layer masks, clipping masks, guides, per-layer
  opacity and blend mode, versions 1 through 11.
- **Compositing** — all 24 blend modes in sRGB as Photoshop does them, twelve adjustment layers
  (Hue/Saturation, Levels, Curves, Exposure, Gradient Map, Grain, Invert, Black & White, Color
  Balance, Gaussian Blur, Motion Blur, Add Noise), paintable layer masks, and folders.
- **Painting and selections** — brush and eraser with size, hardness, opacity, flow and smoothing;
  rectangle, ellipse and lasso selections plus the Magic Wand, with Feather, Expand and Contract;
  a Move tool with snapping and scale/rotate handles.
- **Importing images and exporting a flattened PNG.**
- **Undo throughout, one step per gesture.**
- **A Photoshop-shaped interface**, in English or Simplified Chinese, with user-installable
  language packs.
- **Everything the file holds round-trips**, even where this build cannot yet render it.

Not yet: layer effects and Hue/Saturation's colour-range bands (both read and written, not
rendered); PSD import; camera RAW; selecting a subject; opening a `.comp` by double-clicking it; and
anything to do with a document you would not want to lose, since there is no autosave or crash
recovery.

## Getting started

Requirements: [Rust](https://rustup.rs) (the MSVC toolchain on Windows), Node 22+, pnpm, and the
WebView2 runtime.

```sh
pnpm install
pnpm app          # the desktop window
```

Run the frontend on its own in a browser instead, which loads a demo document, to work on the
canvas, the brush and the blend modes without the desktop shell:

```sh
pnpm dev
```

The other scripts:

| Command | What it does |
|---|---|
| `pnpm check` | Every Rust and TypeScript test |
| `pnpm build` | The frontend bundle |
| `pnpm tauri build` | A signed-installable desktop bundle |
| `node scripts/make-sample-comp.mjs` | Regenerates `examples/sample.comp` |
| `node scripts/dev-browser.mjs` | Headless Chrome with WebGPU, for scripted interface checks |

`examples/sample.comp` is a project worth opening first: it exercises blend modes, a folder, a
clipping mask and a layer mask. `scripts/dev-browser.mjs` starts a **headless** Chrome with remote
debugging and a software Vulkan device, which is how interface changes here were checked — it never
takes the foreground.

### Languages

English is the default and the fallback; Simplified Chinese ships with the app. Anything else is a
JSON file: **Edit › Language › Install Language Pack…**, or drop a file into the language folder and
reload. A pack may translate as much or as little as it likes — an untranslated key reads in English
rather than showing a key name. See [docs/language-packs.md](docs/language-packs.md).

## Extending it

```
crates/core/    the .comp format: manifest schema, validation, package I/O
crates/shaders/ parse- and validation-checks for the WGSL, so a shader typo fails a test
src-tauri/      the desktop shell and the commands the webview may call
web/src/model/  document, blend, adjustments, selections, tools — pure, and testable without a GPU
web/src/render/ the WebGPU compositor, the WGSL, the brush, the PNG encoder
web/src/state/  the session store, and the boundary between the web and Rust
web/src/i18n/   the message tables and the language-pack machinery
web/src/components/  the Vue interface
```

`web/src/model/` holds no canvas, no GPU and no DOM, which is why most of the interesting arithmetic
is tested directly. `web/src/render/` is where anything that needs a GPU lives.

**A tool** is three edits: an entry in `web/src/model/tools.ts` (label key, shortcut, inline SVG,
`implemented: true`), a `case` in the pointer state machine in
`web/src/components/CanvasStage.vue`, and a block for its options in
`web/src/components/OptionsBar.vue`.

**A blend mode** is an entry in `BLEND_MODES`, a branch in `web/src/model/blend.ts`, and a `case` in
`web/src/render/compositor.wgsl`. **An adjustment kind** is the same shape: `ADJUSTMENT_KINDS`,
`buildLut` or a `case` in `web/src/render/adjust.wgsl`, and a block in `AdjustmentPanel.vue`. In both
cases a Rust test parses the real shader and fails if the numbers have drifted out of step, which is
the only way a project graded in this editor and opened in the other stays right.

**A string** is one key in `web/src/i18n/locales/en.json` and one in `zh-CN.json`. A test enforces
that the two cover exactly the same keys with exactly the same placeholders.

**The format** is `crates/core/src/manifest.rs` for the schema and `validate.rs` for the rules.
Anything a newer build could not read means bumping `Manifest::CURRENT_VERSION`, and any field older
builds must tolerate is optional; `docs/language-packs.md` shows the same discipline applied
elsewhere. Rust never builds user-facing prose — it returns a translation key and the values for its
placeholders, and the language pack says it.

How the pieces fit together — the compositing pipeline, the CPU painting path, the saving
protocol, and the three GPU bugs that were found only by running it — is in
[docs/architecture.md](docs/architecture.md).

**Tests first.** `pnpm check` runs everything: the Rust tests cover the format and the shader, and
the TypeScript tests cover the arithmetic, the layer tree and the message tables. Behaviour that
only a GPU can show — every blend mode, every adjustment kind, the brush, the selections, the
handles, mask painting — was checked by driving the real interface in headless Chrome, and three of
the bugs found that way could not have been found any other way.

## Attribution and licence

**This project is a derivative work of
[robbietilton/Compositor](https://github.com/robbietilton/Compositor)**, MIT licensed, Copyright (c)
2026 Wonder Assembly LLC. Its notice is reproduced in [NOTICE](NOTICE), as its terms require.

Nothing here is a copy of that project's source — it is a different language, a different UI toolkit
and a different rendering stack. What was derived from it is the design:

- the `.comp` format — its schema, version history, validation rules and limits;
- the 24 blend-mode formulas, and the choice to blend in sRGB rather than linear light;
- the twelve adjustment formulas: Levels, the shape-preserving Curves interpolation, Exposure in
  linear light, the Black & White channel mixing, Colour Balance's tonal weights, and the
  gradient-map and grain hashes;
- the compositing model: pass-through folders, a folder's opacity multiplying into its children,
  clipping masks as alpha links, and adjustments affecting what is composited below them;
- Hue/Saturation's HSL maths and Photoshop's multiplicative saturation;
- the interface, which imitates the original's and, behind it, Photoshop's.

If you are the author of the original and would like anything here worded or attributed
differently, please open an issue.

This project is released under the **MIT License**, Copyright (c) 2026 ducaoya
<ducaoya@gmail.com>.
