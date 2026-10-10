# What is left

The README says what the editor does and where it stands. This is the ledger behind that: what is
not written, what is written but not proven, what is waiting on a decision, and what is deliberately
not being done at all. It exists so that a decision does not have to be reconstructed from a commit
message six weeks later.

## Features

- **The Type tool.** Type layers round-trip; nothing edits them in the canvas. A text overlay that
  commits to pixels on Enter, plus a per-layer rasterisation, is the shape it wants.
- **PSD and PSB import.** The format is documented and the reference app has a reader; this build has
  neither. The largest piece of parity left — a layer model maps across well, layer *effects* do not.
- **Selecting a subject, and Remove Background.** One feature behind two menu items: an ONNX model in
  the webview. **U2Netp** (Apache-2.0) if it lands, never RMBG-1.4, whose licence forbids commercial
  use. Shipping a model is a build-and-licence question as much as a code one.
- **The shell's half of the file-manager thumbnail.** The drawing half is done and verified —
  `Compositor.exe --thumbnail <project> <png> [size]`, documented under
  [Getting started](../README.md#getting-started). What is missing is the registration, and that is
  blocked on the decision below rather than on code.

## A decision, then a small piece of work

**How a `.comp` gets a picture in Explorer.** A `.comp` is a *folder*, and Windows has no
per-extension thumbnail path for a folder: `IThumbnailProvider` is initialised from a file stream,
which a directory does not have. The two ways around it are:

| | Cost |
|---|---|
| **A `desktop.ini` with a `CLSID2` written into every project.** | The standard way to make a folder behave like a file, and it changes what a package contains. The format is shared with the macOS reference app, so it is a decision about the format too. |
| **An icon handler registered for all folders** in `HKCR\Folder\ShellEx\IconHandler`, returning failure for anything that is not a `.comp`. | No project is touched. It takes a key other applications also register in — only one handler can hold it — and loads our DLL into every folder's thumbnail path. |

Neither can be verified here: both need an installed bundle and a restarted Explorer. The renderer
is the part with the correctness risk, and it is done; whichever way this goes, the rest is a few
registry writes and a DLL that runs the renderer and loads the PNG it wrote.

## Implemented, not yet proven

- **Installing an update.** Checking, downloading, signature verification and the swap are wired, and
  two signed installers build — but no update has ever been installed over another. The first release
  has not been triggered at all: bump `version` in `src-tauri/tauri.conf.json`, then either push a
  commit whose *subject* starts with `[release]`, push a `v*` tag, or run the workflow by hand.
- **The installer's own half of double-clicking.** The command line is parsed and tested and a second
  launch is tested; the file association an installed bundle registers is not.
- **The thumbnail renderer in an installed build.** Verified against a development build only.

## Deliberately not

- **Camera RAW** — the closest pure-Rust decoder, `rawler`, is LGPL-2.1, and linking it statically
  into an MIT binary makes the whole binary LGPL.
- **HEIC** — the decoder belongs to the platform and reaching it from Rust is not done here.
- **Some TIFFs** — tiles, JPEG and CCITT compression, YCbCr, floating-point samples, BigTIFF,
  multi-page. Each is refused by name, with the reason.
- **Layer comps, smart objects, video and 3D.**

## Housekeeping

- **The signing key** is a repository secret for CI and a file in `~/.tauri/` for a developer. One
  file is a single point of failure for every installed build that will ever want an update: a copy
  in a password manager is the cheap insurance. Rotating it means releasing a version signed with the
  *old* key that carries the new public key — the only way to move a key for software already out.
- **Nothing tests `master` before a release.** The release workflow runs on a marker, not on a plain
  push, so a broken commit is found when someone tries to release rather than when it lands. A checks
  workflow on every push is a few lines.
