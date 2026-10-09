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
- **Filters** — Gaussian Blur, Add Noise, Vignette, Bloom / Glow, Tonal Contrast, Lens Correction and
  Dither (error diffusion, an 8×8 pattern or noise, at any number of levels per channel), each with
  its own settings dialog.
- **Importing** — anything the webview decodes, plus SVG (rasterised at its own size) and TIFF
  (uncompressed, PackBits, LZW and Deflate), and exporting a flattened PNG or JPEG.
- **Hue/Saturation's colour-range bands** — the six ranges Photoshop has, each with its own hue,
  saturation and lightness and its own band edges.
- **Undo throughout, one step per gesture.**
- **Nothing unsaved is lost to a crash.** While a document has changes that are not on disk it is
  snapshotted into the app's data folder — once the editing has stopped, and at most once every
  thirty seconds — and the next start offers whatever it finds. Saving a recovered document writes
  back to the project it came from, never into the recovery folder.
- **A `.comp` opens by double-clicking it**, in the window that is already running rather than in a
  second copy of the app.
- **Updates that can be installed**, from the Help menu: the bundle is downloaded and its signature
  checked against a public key compiled into the app before anything is replaced. See
  [Updating](#updating).
- **A Photoshop-shaped interface**, in English or Simplified Chinese, with user-installable
  language packs.
- **Every shortcut is remappable.** *Edit › Keyboard Shortcuts…* lists every command this build has:
  click a key, press the ones you want it on. A key that was already taken is released from whatever
  had it, and the one chord two commands turned out to share — merge and export PNG, both on Ctrl+E —
  has been split.
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
- **A thumbnail in the file manager.** Explorer's thumbnail provider has to be a COM DLL, and a
  thumbnail has to be *composited* — 24 blend modes, twelve adjustments, masks, effects. Either that
  maths is written a third time in Rust (there are already two copies, TypeScript and WGSL, kept in
  step by a test that reads the real shader) or the provider shells out to the app's own renderer,
  which starts a webview for every file the file manager looks at. Neither is a good trade yet, so a
  `.comp` shows the app's icon, which is what it showed before.

## Status

The rewrite this project was built to was cut into three tiers, each one a shippable product. Tier 1
(the whole chain — read and write the format, composite, paint, select, import, export, undo) and
Tier 2 (masks, the twelve adjustment layers, transforms, layer effects, the rest of the tools) are
complete. Tier 3 is partly done.

| Tier | State |
|---|---|
| **1 — the whole chain** | complete. `.comp` versions 1–11, 24 blend modes, painting, selections, import and export, undo throughout. |
| **2 — everyday use** | complete but for the Type tool: layer and clipping masks, twelve adjustment layers, transforms with snapping and guides, the Magic Wand, gradients, shapes, six layer effects, drag-and-drop import. |
| **3 — feature parity** | partial: Content-Aware Fill, Clone Stamp, Spot Healing, Smudge, Vignette, Bloom/Glow, Tonal Contrast, Lens Correction, Dither, a command palette, remappable shortcuts, Hue/Saturation's colour-range bands, rulers and the pixel grid. |

What is left of Tier 3 is [Not yet](#not-yet) and
[What it will not open](#what-it-will-not-open-and-why): PSD and PSB, selecting a subject, the Type
tool, Camera Raw, Remove Background, Liquify, and a shell thumbnail handler. Autosave and crash
recovery, opening a project by double-clicking it, the install half of updating, dithering and
remappable shortcuts are all here now, and are described above and in [Updating](#updating).

Four things are here that the plan did not call for, because the port turned out to need them: SVG
and TIFF import, mip chains for both of the frame's downsamples, and the retouch tools beyond clone
stamp and spot healing — Blur, Sharpen, Smudge, Dodge, Burn and Sponge.

**Where it stands:** version 0.1.0, with 319 TypeScript tests, 43 Rust tests, and 27 pixel cases that
drive a real build in headless Chrome. `pnpm check` runs the first two; the pixel cases need a dev
server and `scripts/dev-browser.mjs`, which [docs/architecture.md](docs/architecture.md) explains.

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
| `pnpm tauri build` | A desktop bundle to install. Unsigned, and it needs no key: signing is a release concern — see [Releasing](#releasing). |
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

Where it looks is named in two places, and they have to agree: `plugins.updater.endpoints` in
`src-tauri/tauri.conf.json`, which is the manifest the *installer* reads and is compiled into the
binary, and `updateEndpoint` in `web/src/state/session.ts`, defaulting to the same
`http://localhost:8787/latest.json`, which is the one the check reads so its answer can be tested
without a shell. Serve that file from anywhere static — a local server while developing, a release
page afterwards.

The second `Install Update…` item appears in the Help menu once a check has found a release with a
bundle for this platform. Choosing it downloads the bundle, reports how far along it is in the menu
bar, verifies the signature and installs, then restarts into the new build. Nothing is replaced
until someone asks for it.

The updater refuses a plain-`http` endpoint, and a build that names one without admitting to it does
not start at all — that is why `plugins.updater.dangerousInsecureTransportProtocol` is on beside the
local default. A release points the endpoint at `https` and can drop the flag. The signature check
is what protects the bundle either way: a manifest read over plain http can be swapped for one that
offers an older release, but not for one whose contents will install.

### Installing: what a release needs

The download, the signature check and the swap are wired up. Signing, however, needs keys, and they
are per-project, so this is what a release does with them:

1. Generate a key pair once: `pnpm tauri signer generate -w ~/.tauri/compositor.key`. Keep the
   private key private — it is what makes an update installable — and put the **public** key in
   `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. A development key is already there: it
   is the one generated while wiring this up, and it is why a locally built bundle can be installed
   over a locally built one. In a team the private half lives in CI rather than on a laptop, which
   is what [Releasing](#releasing) is about.
2. Publish the manifest above wherever `plugins.updater.endpoints` names, with one entry per
   platform and the bundle's `signature` beside its `url`. A published build points that endpoint at
   the release page; a development build points it at a file on the developer's machine.
3. Build with the private key available: `TAURI_SIGNING_PRIVATE_KEY=… pnpm tauri build --config
   src-tauri/tauri.release.conf.json`. Tauri signs each bundle and writes a `.sig` file beside it,
   whose contents go into the manifest as that platform's `signature`;
   `bundle.createUpdaterArtifacts` turns this on — and it is in the release configuration overlay,
   not the base one, which is why a developer's `pnpm tauri build` produces installers and nothing
   that needs signing. The CLI does not assemble the manifest itself; the release workflow does, and
   by hand it is a dozen lines of JSON.

Both installers are built and both are signed, and the updater uses the NSIS one on Windows, which
is the `.exe` under `windows-x86_64`. An update installed over the MSI route would use
`windows-x86_64-msi` and the `.msi` beside it.

Self-signed is deliberate while this is developed: a development build signed with its own key is a
complete, verifiable path, and swapping in a real certificate later means generating the pair from
that authority and replacing one public key. Nothing in the code assumes the development key.

## Releasing

A release is a commit message, a tag, or a button. All three run the same workflow
(`.github/workflows/release.yml`), and all three do the same four things: test, build, sign, publish.

| Trigger | What it is for |
|---|---|
| A push to `master` whose commit subject starts with `[release]` | The everyday path: the work is merged, and the commit that says so is the one that ships. |
| A tag pushed as `v0.2.0` | For the habit of tagging. The tag and the version in `src-tauri/tauri.conf.json` must agree. |
| **Actions › Release › Run workflow** | Running a release again after a failure, without inventing a commit. |

Before any of them, bump `version` in `src-tauri/tauri.conf.json`. That number is the tag, the name
of the release, and the version the app reports to an update check — and a release that forgets to
bump it fails with that sentence rather than quietly republishing the last one.

The marker has to be the first thing in the commit subject. A `[release]` written halfway down a
message body is a word, not a decision: nothing publishes from a commit that merely mentions it.

What lands on the release page for `v<version>`:

- the two installers, `Compositor_<version>_x64-setup.exe` and `Compositor_<version>_x64_en-US.msi`;
- a `.sig` beside each, which is the signature the app checks a download against;
- `latest.json`, the manifest **Help › Check for Updates** and **Install Update** read, which a
  published build names as
  `https://github.com/ducaoya/compositor-next/releases/latest/download/latest.json`.

The same bundles are attached to the workflow run itself as well, so a build can be looked at
without being installed.

### The signing key, and where it lives

The private key is a repository secret — `TAURI_SIGNING_PRIVATE_KEY`, and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when the key has a password. It is not on a developer's machine
and not in a checkout, which is the point: nobody has to be trusted with it, no laptop can leak it,
and a colleague leaving changes nothing about how releases work. `.gitignore` carries `*.key` so a
copy cannot be committed by accident.

Two consequences are worth knowing:

- **A local build needs no key.** The updater artifacts are configured in
  `src-tauri/tauri.release.conf.json`, and only CI passes that file (`--config`), so
  `pnpm tauri build` on a developer's machine produces installers and nothing to sign.
- **Losing the private key is not recoverable.** An installed copy accepts updates only from the key
  compiled into it, so a lost key means every existing install has to be replaced by hand. Keep a
  copy in a password manager or a vault, and change keys by publishing a version signed with the old
  key that carries the new public key — the only way to move a key for software already out there.

Set the secret once, from the key generated while wiring this up:

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/compositor.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body "…"   # only if the key has a password
```

### Unsaved work, and what a crash costs

A document with changes that are not on disk is snapshotted into the app's data folder — under
`recovery/`, one folder per document — once the editing has stopped for five seconds and at most
every thirty seconds. A snapshot is an ordinary `.comp` package, written through the same staging
and atomic swap a save uses, plus a small sidecar saying which project it came from.

That makes the lifecycle short and the recovery simple. A snapshot is thrown away when the work
reaches its own file, and kept when a tab is closed with unsaved changes. So whatever is still there
at startup belongs to work that was lost, and the app asks about it: recover it, or discard it.
Recovering opens the snapshot as a document that remembers where it came from, and saving writes it
back to that project — recovery never overwrites a project on its own, and never leaves a copy of
one in the recovery folder. [docs/architecture.md](docs/architecture.md) has the reasoning.

A `.comp` opened from Explorer or the file manager arrives as a command-line argument, and a second
launch does not start a second copy of the app: it hands the path to the window already running,
which opens the project there. Two processes writing one package is how a package gets corrupted,
so there is only ever one.

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
