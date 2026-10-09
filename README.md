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
  Balance, Gaussian Blur, Motion Blur, Add Noise), six layer effects, paintable layer masks, and
  folders. Every layer texture and the frame itself carry mip chains, so a layer drawn smaller than
  its own pixels does not shimmer.
- **Painting and selections** — brush and eraser with size, hardness, opacity, flow and smoothing;
  rectangle, ellipse and lasso selections plus the Magic Wand, with Feather, Expand and Contract;
  a Move tool with snapping and scale/rotate handles; rulers, guides, a grid, and a pixel grid once
  a document pixel is eight screen pixels across.
- **Retouching** — Clone Stamp with an aligned source, Spot Healing Brush in its three modes, Blur,
  Sharpen and Smudge, Dodge, Burn and Sponge, and Content-Aware Fill. The healing, smudging, blurring
  and filling kernels are ports of the reference app's C, tested over typed arrays without a GPU.
- **Filters** — Gaussian Blur, Add Noise, Vignette, Bloom / Glow, Tonal Contrast and Lens Correction,
  each with its own settings dialog.
- **Importing** — anything the webview decodes, plus SVG (rasterised at its own size) and TIFF
  (uncompressed, PackBits, LZW and Deflate), and exporting a flattened PNG or JPEG.
- **Hue/Saturation's colour-range bands** — the six ranges Photoshop has, each with its own hue,
  saturation and lightness and its own band edges.
- **Undo throughout, one step per gesture.**
- **A Photoshop-shaped interface**, in English or Simplified Chinese, with user-installable
  language packs.
- **Everything the file holds round-trips**, even where this build cannot yet render it.

### What it will not open, and why

Refusing a file by name, with a reason, is the point: a file that opens to something wrong is worse
than one that says it cannot be opened.

- **Camera RAW** (`.cr2`, `.nef`, `.dng` and the rest) — no decoder, on licensing. The closest
  pure-Rust one, `rawler`, is **LGPL-2.1**, and statically linking that into an MIT binary would make
  the whole binary LGPL. Nothing links it, and the import path says so in words.
- **HEIC** — the decoder belongs to the platform. Windows' WIC has one and the reference app used it;
  reaching WIC from the Rust side is not done here, so a HEIC file says so rather than failing
  silently.
- **Some TIFFs** — tiles, JPEG and CCITT compression, YCbCr, floating-point samples, BigTIFF and
  multi-page files are each refused with the reason.

### Not yet

- **PSD and PSB** import. The format is documented and the reference has a reader; this build has
  neither.
- **Selecting a subject.** Needs an ONNX model in the webview, which is a feature rather than a
  change; if it lands it will be **U2Netp** (Apache-2.0), never RMBG-1.4, whose licence forbids
  commercial use and so is incompatible with this one.
- **The Type tool.** Type layers round-trip; nothing edits them in the canvas yet.
- **Layer comps, smart objects, video, and 3D.**
- **Opening a `.comp` by double-clicking it**, and anything to do with a document you would not want
  to lose: there is no autosave and no crash recovery.
- **Installing an update.** *Checking* for one is implemented and tested; downloading a signed bundle
  and replacing the running binary is the shell's job and is not wired up. See [Updating](#updating).

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
web/src/render/retouch/  the retouch kernels: healing, content fill, smudge, tone, blur — pure
web/src/render/filters/  the finishing filters' kernels — pure, and tested the same way
web/src/io/     the import path: SVG rasterising and a TIFF reader
web/src/state/  the session store, and the boundary between the web and Rust
web/src/i18n/   the message tables and the language-pack machinery
web/src/components/  the Vue interface
```

`web/src/model/` holds no canvas, no GPU and no DOM, which is why most of the interesting arithmetic
is tested directly. `web/src/render/` is where anything that needs a GPU lives, and the two kernel
directories next to it are pure functions over typed arrays for the same reason — a healing kernel
or a lens warp is arithmetic, and arithmetic does not need a browser to be tested.

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

**An import format** is a branch in `web/src/io/imports.ts`: either a decoder (as TIFF and SVG have)
or a refusal with a reason. `refusalFor` is where a format this build will not open is named, and
both the reason and the message are in the language tables.

**A pixel test** is a case in `scripts/gpu-test.mjs`, which drives a running build over the Chrome
debugging protocol. It has two readbacks and which one a case uses is part of what it asserts:
`renderAndRead` reads the accumulation at document resolution, and `renderAndReadView` snapshots the
canvas as shown, which is the only way to see the zoom, the pan or which mip level a shrunken frame
is sampled at.

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

## Updating

**Check for Updates** in the Help menu fetches a manifest, compares versions and says what it finds.
The comparison is semver's, including the two cases that are usually wrong: `0.10.0` is newer than
`0.9.0`, and a release is newer than its own pre-releases, so an app on `1.2.0-rc.1` is offered
`1.2.0` and an app on `1.2.0` is not offered `1.2.0-rc.2`. `web/src/model/update.ts` holds that and
is tested on its own; `checkForUpdates` in `web/src/state/session.ts` does the fetch.

The manifest is a list of releases, each with a bundle per platform, which is the shape Tauri's own
updater speaks:

```json
{ "releases": [ { "version": "0.2.0", "notes": "…",
  "platforms": { "windows-x86_64": { "url": "https://…/Compositor_0.2.0_x64_en-US.msi",
  "signature": "…" } } } ] }
```

Where it looks is one line: `updateEndpoint` in `web/src/state/session.ts`, defaulting to
`http://localhost:8787/latest.json`. Serve that file from anywhere static — a local server while
developing, a release page afterwards.

### Installing, which is not built yet

Downloading a bundle and replacing the binary the app is running inside is the shell's job, and it
is the half that needs signing keys. The steps, in order:

1. Generate a key pair: `pnpm tauri signer generate -w ~/.tauri/compositor.key`. Keep the private
   key private and put the **public** key in `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
2. Add the updater plugin (`tauri-plugin-updater` in `src-tauri/Cargo.toml`, the same version's npm
   package, and `updater:default` in `src-tauri/capabilities/default.json`), with
   `plugins.updater.endpoints` naming the manifest above.
3. Build with the private key available: `TAURI_SIGNING_PRIVATE_KEY=… pnpm tauri build`. Tauri signs
   each bundle and writes the signature into the manifest you publish.
4. Point `updateEndpoint` at wherever that manifest is, and add a call to the plugin's `install`
   where `checkForUpdates` now only reports.

Self-signed is deliberate while this is developed: a development build signed with its own key is a
complete, verifiable path, and swapping in a real certificate later means generating the pair from
that authority and replacing one public key. Nothing in the code assumes the development key.

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

### What is deliberately not a dependency

Two decoders this app would like to have are left out for their licences, and both are left out
loudly — the import path names the reason rather than failing generically — because a licence
question is not one a decoder gets to answer on the project's behalf.

- **`rawler`** (camera RAW) is **LGPL-2.1**. Statically linking an LGPL library into an MIT binary
  makes the whole binary LGPL, so this project links nothing and refuses RAW files by name.
- **RMBG-1.4** (background removal) is licensed for **non-commercial use only**, which cannot be
  combined with an MIT release. If subject selection lands it will use a permissively licensed model
  (U2Netp is Apache-2.0).

Everything else that does pixel work here is either this project's own port or was written from a
specification: the retouch kernels are ports of the reference app's C (MIT), the TIFF reader, the
SVG rasteriser, the filters and the update comparison are this project's. There are no C dependencies
in the Rust crates.
