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

## Autosave, and what a snapshot is

Crash recovery is built out of what already existed rather than out of a second way of writing
projects. A snapshot *is* a `.comp` package: `begin_save` stages it, `write_asset` and `link_asset`
fill it, `commit_save` swaps it in. An autosave therefore costs what a save costs, and there is no
new code in which a half-written project could hide.

Three decisions follow from that.

**One folder per document, named after where it came from.** `Poster-3f2a19c4` is the file's stem
plus an FNV-1a of its full path, so two projects both called `Untitled.comp`, on two drives, never
share a snapshot — and someone looking in the folder can tell what is there. A document that has
never been saved has no path to fingerprint, so its tab's id is the key instead, which is what keeps
repeated autosaves of an untitled document on one folder rather than making a new one each time.

**The sidecar is written after the swap, never before.** `<key>.json` records which project the
snapshot beside it came from. Writing it first would leave a label pointing at a package a crash
never finished, and the next start would offer a document that cannot be opened. A sidecar whose
package no longer loads is dropped the moment it is listed, which is also the only cleanup needed:
nothing else here can be left half-written.

**A snapshot lives exactly as long as the work is unsaved.** Saving discards it, closing a clean tab
discards it, closing a dirty one keeps it. That is what makes the startup question worth asking —
anything still there belongs to work that was lost, to a crash or to a window closed with unsaved
changes — and it is why nothing deletes snapshots on the way out. Deleting on exit is how crash
recovery fails in precisely the case it exists for.

When the editing has stopped is the frontend's business, because that is a question about a person
and not about a file: five seconds of quiet, and no more than one snapshot per thirty seconds. The
quiet time is what keeps a snapshot from being taken mid-drag; the gap is what keeps a document
edited in bursts from being encoded every two seconds. Both live in `web/src/model/recovery.ts`
beside the decision function, so the arithmetic is tested without a shell, a folder or a clock.

Recovery never overwrites a project. A recovered document opens the snapshot — that package is what
it is — and remembers the project it came from; saving writes back there, and then re-reads that
project so its asset paths are the project's own files rather than the snapshot's, which is about to
be deleted. Without that last step the following save would try to link from files that no longer
exist. A recovered document that never had a path asks for one, because writing into the recovery
folder would leave the real project untouched and two versions of everything.

## One copy of the app, and one package

A second launch of a `.comp` — a double-click while the app is already open — does not start a second
copy. It hands its command line to the window that is running, which opens the project there. Two
processes saving one package is the one thing staging and swapping cannot protect against: each
would rename its own staging folder over the other's work.

That is also why an arriving path is recognised by its extension rather than by its position:
`comp_path_from_args` in `src-tauri/src/lib.rs` reads the whole argument list, trims the quotes the
shell adds and the `\\?\` prefix Windows adds, and takes the first thing that ends in `.comp`. It is
tested against the shapes a shell actually produces rather than the one shape a developer assumes.

## A write of our own is not an outside change

Saving swaps the package on disk, and the watcher reports that like any other write — so the app
used to reload the document it had just saved a third of a second later, and take the undo history
with it, because a reload clears the stack. `wroteAt` in `web/src/state/session.ts` is set as a
package is written and checked as a watcher event is about to be acted on: a change this app made is
not news.

A recovered document that is saved names a folder it was not watching, so it re-arms its watch
there. The watcher's id is the tab rather than the path, which is what makes that a replacement
rather than a second watcher left behind on a folder that is about to be deleted — and closing a tab
stops its watch for the same reason.

## The two halves of an update

The decision half is TypeScript (`web/src/model/update.ts`): semver, including the two cases usually
got wrong, and which release a manifest offers for this platform. It fetches the manifest itself
through `setUpdateEndpoint`, so it can be tested without a shell — the update-check pixel case serves
it from a `data:` URL.

The installation half cannot be TypeScript at all, because it replaces the binary the webview is
running inside. That half is Tauri's updater plugin: it downloads the bundle and verifies it against
the public key compiled into the app. None of the download or the signature check is ours, and that
is the point — a signature check written here would be a signature check written wrong.

The consequence is that the manifest is named twice: `plugins.updater.endpoints` for the installer,
compiled in, and `updateEndpoint` for the check. They have to agree. The check's answer is a report;
the installer's is the truth.

The private key is the other reason the two halves are split. It is a repository secret, used by the
release workflow and nothing else; the updater artifacts it produces are turned on by
`src-tauri/tauri.release.conf.json`, which only CI passes with `--config`. That file also points the
endpoint at the release page, so a published build looks for updates in a different place than a
development one — and a developer's `pnpm tauri build` needs no key at all, which is what stops one
person's machine from being part of the release process.

## The keyboard is data, not a chain of comparisons

Every command and the key it ships with is one table (`web/src/model/keymap.ts`). The menus name their
command and read the chord for their labels out of it, the shortcut sheet edits it, and the window's
key handler resolves a press through it — which is what makes a rebind appear on a menu label without
anyone touching the menu.

Two rules are worth keeping in mind when changing it:

- **A chord belongs to one menu command.** Assigning a key takes it away from whatever had it, and
  the sheet names what lost it. Two commands on one key is a keyboard nobody can predict, and it was
  already true here: merge and export PNG were both on `Ctrl+E`, and the handler had to pick one,
  every time. Tools are exempt, and deliberately — three of them sharing `R` *is* the cycle, and which
  tools cycle together is read from the bindings rather than from the tool table, so rebinding one
  moves it into its new group.
- **One command has a fixed alternate that cannot be rebound.** Delete clears a layer and Backspace
  does too: remapping one of a pair would leave the other working, which is a worse surprise than not
  allowing the rebind. `CommandDefinition.alt` is that list, and the sheet's footnote is where the
  keyboard's remaining fixed keys (arrows, Enter, Escape) are stated.

Only overrides are stored in local storage, never the resolved map: a default changed in a later build
then reaches someone who has rebound something else, instead of being pinned to what the default used
to be.

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
- `src-tauri` — the argument list a double-click arrives as, the naming and the checking of recovery
  snapshots, and the file watcher.
- `web` — the blend maths (including the sRGB-not-linear-light check), the adjustment maths, the
  selection and selection-mask maths, the layer tree, undo, the layer operations, the retouch and
  filter kernels, the TIFF reader, the version comparison, the download progress, the autosave
  arithmetic, and the i18n tables.

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
