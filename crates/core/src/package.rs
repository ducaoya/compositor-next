//! Reading and writing the `.comp` package on disk.
//!
//! ```text
//! Example.comp/
//! ├── manifest.json
//! └── images/
//!     ├── 6F1D….png        a layer's pixels
//!     └── 6F1D….mask.png   its mask
//! ```
//!
//! Saving stages the whole package in a sibling folder and then swaps it in. A reader therefore
//! sees either the old project or the new one, never a half-written one — the same guarantee the
//! reference app gets from `FileWrapper.write(options: .atomic)`, and the reason its file watcher
//! can reload on every change without checking for partial writes.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use uuid::Uuid;

use crate::{
    error::{AssetFile, AssetKind, PackageAssets, Project, ProjectError},
    limits::Limits,
    manifest::{Header, Manifest, FORMAT_ID},
    png,
    validate::{charge_pixels, validate},
};

pub const MANIFEST_NAME: &str = "manifest.json";
pub const IMAGES_DIR: &str = "images";
/// Finder's Space-bar preview. The reference app writes it; this one only has to clear it so a
/// stale picture is not shown.
pub const QUICKLOOK_DIR: &str = "QuickLook";

/// Reads a project: the manifest first, then each asset's header.
///
/// Pixels stay on disk. The caller decodes them (the webview can do it straight into a texture).
pub fn load(root: impl AsRef<Path>, limits: &Limits) -> Result<Project, ProjectError> {
    load_with(root, limits, |_, _| {})
}

/// As `load`, calling `on_asset` with each asset's name and byte length as it is checked. Useful for
/// progress reporting on large projects.
pub fn load_with(
    root: impl AsRef<Path>,
    limits: &Limits,
    mut on_asset: impl FnMut(&str, u64),
) -> Result<Project, ProjectError> {
    let root = root.as_ref();
    if !root.is_dir() {
        return Err(ProjectError::NotFound(root.to_path_buf()));
    }

    let manifest_path = root.join(MANIFEST_NAME);
    let metadata = fs::read(&manifest_path)?;
    if metadata.len() as u64 > limits.manifest_bytes {
        return Err(ProjectError::TooLarge(limits.document_budget_megapixels()));
    }

    // The header check comes first, so a foreign or newer file is rejected before anything else.
    let header: Header = serde_json::from_slice(&metadata).map_err(|_| ProjectError::Invalid)?;
    if header.format != FORMAT_ID {
        return Err(ProjectError::Invalid);
    }
    if !(crate::MIN_VERSION..=crate::CURRENT_VERSION).contains(&header.version) {
        return Err(ProjectError::Version(header.version));
    }

    let manifest: Manifest = serde_json::from_slice(&metadata).map_err(|_| ProjectError::Invalid)?;
    validate(&manifest, limits)?;

    let mut images = HashMap::new();
    let mut masks = HashMap::new();
    let mut pixels = 0u64;
    let mut mask_pixels = 0u64;

    for layer in &manifest.layers {
        for kind in [AssetKind::Image, AssetKind::Mask] {
            let name = match kind {
                AssetKind::Image => layer.image_file.as_ref(),
                AssetKind::Mask => layer.mask_file.as_ref(),
            };
            let Some(name) = name else { continue };
            let path = root.join(IMAGES_DIR).join(name);
            check_asset_file(root, &path, limits)?;
            let bytes = fs::read(&path)?;
            on_asset(name, bytes.len() as u64);

            let header = png::header(&bytes).ok_or(ProjectError::MissingImage)?;
            match kind {
                AssetKind::Image => {
                    if !header.is_layer_pixels() {
                        return Err(ProjectError::MissingImage);
                    }
                    charge_pixels(header.width, header.height, &mut pixels, limits)?;
                }
                AssetKind::Mask => {
                    if !header.is_mask() {
                        return Err(ProjectError::Invalid);
                    }
                    charge_pixels(header.width, header.height, &mut mask_pixels, limits)?;
                }
            }

            let asset = AssetFile { path, width: header.width, height: header.height };
            match kind {
                AssetKind::Image => images.insert(layer.id, asset),
                AssetKind::Mask => masks.insert(layer.id, asset),
            };
        }
    }

    Ok(Project { manifest, images, masks, root: root.to_path_buf() })
}

/// Writes a project, replacing whatever was at `root`.
///
/// Assets are staged on disk rather than held in memory, so a 2 GB project saves in the same shape
/// as a small one. Prefer [`staging_directory`] + [`save_staged`] when the caller already has the
/// bytes on disk (which is what the Tauri command layer does).
pub fn save(
    root: impl AsRef<Path>,
    manifest: &Manifest,
    assets: &PackageAssets,
    limits: &Limits,
) -> Result<(), ProjectError> {
    let root = root.as_ref();
    validate(manifest, limits)?;

    let staging = staging_directory(root)?;
    let outcome = (|| -> Result<(), ProjectError> {
        for ((layer, kind), bytes) in &assets.files {
            let declared = declared_name(manifest, *layer, *kind);
            if declared.is_none() {
                return Err(ProjectError::layer_rule(*layer, "assetNotDeclared"));
            }
            fs::write(staging.join(IMAGES_DIR).join(kind.required_file_name(*layer)), bytes)?;
        }
        Ok(())
    })();
    if let Err(error) = outcome {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    save_staged(&staging, root, manifest, limits)
}

/// Creates the staging folder beside `target`, clearing anything a crashed run left there.
///
/// The folder sits next to the target on purpose: the final swap is a rename, and a rename across
/// volumes would copy instead of being atomic.
pub fn staging_directory(target: &Path) -> Result<PathBuf, ProjectError> {
    let parent = target.parent().ok_or(ProjectError::Invalid)?;
    let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("project");
    // Sweep leftovers from earlier runs: they are always `.<name>.staging.*` or `.<name>.previous.*`.
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(file_name) = file_name.to_str() else { continue };
            let is_leftover = file_name.starts_with(&format!(".{name}.staging."))
                || file_name.starts_with(&format!(".{name}.previous."));
            if is_leftover {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }

    let staging = sibling(target, "staging")?;
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(staging.join(IMAGES_DIR))?;
    Ok(staging)
}

/// Validates a staged package, writes its manifest, and swaps it in over `target`.
///
/// `staging` must have been made by [`staging_directory`] and have its assets already written into
/// `staging/images`. On success the staging folder no longer exists: it *is* the target.
pub fn save_staged(
    staging: &Path,
    target: &Path,
    manifest: &Manifest,
    limits: &Limits,
) -> Result<(), ProjectError> {
    validate(manifest, limits)?;

    let mut pixels = 0u64;
    let mut mask_pixels = 0u64;

    let outcome = (|| -> Result<(), ProjectError> {
        for layer in &manifest.layers {
            for kind in [AssetKind::Image, AssetKind::Mask] {
                if declared_name(manifest, layer.id, kind).is_none() {
                    continue;
                }
                let path = staging.join(IMAGES_DIR).join(kind.required_file_name(layer.id));
                let metadata = fs::symlink_metadata(&path).map_err(|_| ProjectError::MissingImage)?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(ProjectError::MissingImage);
                }
                if metadata.len() > limits.asset_bytes {
                    return Err(ProjectError::TooLarge(limits.document_budget_megapixels()));
                }
                let bytes = fs::read(&path)?;
                let header = png::header(&bytes).ok_or(ProjectError::Encode)?;
                match kind {
                    AssetKind::Image => {
                        if !header.is_layer_pixels() {
                            return Err(ProjectError::Encode);
                        }
                        charge_pixels(header.width, header.height, &mut pixels, limits)?;
                    }
                    AssetKind::Mask => {
                        if !header.is_mask() {
                            return Err(ProjectError::Invalid);
                        }
                        charge_pixels(header.width, header.height, &mut mask_pixels, limits)?;
                    }
                }
            }
        }

        // Sorted keys and two-space indentation, as the reference encoder writes.
        let metadata = serde_json::to_string_pretty(&serde_json::to_value(manifest)?)?;
        if metadata.len() as u64 > limits.manifest_bytes {
            return Err(ProjectError::TooLarge(limits.document_budget_megapixels()));
        }
        fs::write(staging.join(MANIFEST_NAME), metadata)?;
        Ok(())
    })();

    if let Err(error) = outcome {
        let _ = fs::remove_dir_all(staging);
        return Err(error);
    }

    swap_in(staging, target)
}

/// The file name a manifest declares for one asset, if it declares one.
fn declared_name(manifest: &Manifest, layer: Uuid, kind: AssetKind) -> Option<String> {
    manifest
        .layers
        .iter()
        .find(|record| record.id == layer)
        .and_then(|record| match kind {
            AssetKind::Image => record.image_file.clone(),
            AssetKind::Mask => record.mask_file.clone(),
        })
}
/// Replaces `root` with `staging`, restoring the old project if the swap fails partway.
fn swap_in(staging: &Path, root: &Path) -> Result<(), ProjectError> {
    if !root.exists() {
        fs::rename(staging, root)?;
        return Ok(());
    }
    // Windows cannot rename over a directory, so the old package steps aside first. The window in
    // which neither exists is two renames wide.
    let previous = sibling(root, "previous")?;
    let _ = fs::remove_dir_all(&previous);
    fs::rename(root, &previous)?;
    match fs::rename(staging, root) {
        Ok(()) => {
            let _ = fs::remove_dir_all(&previous);
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(&previous, root);
            let _ = fs::remove_dir_all(staging);
            Err(ProjectError::Io(error))
        }
    }
}

fn sibling(root: &Path, marker: &str) -> Result<PathBuf, ProjectError> {
    let parent = root.parent().ok_or(ProjectError::Invalid)?;
    let name = root.file_name().and_then(|n| n.to_str()).unwrap_or("project");
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(parent.join(format!(".{name}.{marker}.{stamp}")))
}

/// Rejects a symlinked, oversized or out-of-package asset.
fn check_asset_file(root: &Path, path: &Path, limits: &Limits) -> Result<(), ProjectError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ProjectError::MissingImage)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ProjectError::Invalid);
    }
    if metadata.len() > limits.asset_bytes {
        return Err(ProjectError::TooLarge(limits.document_budget_megapixels()));
    }
    // The manifest validator already insists a file name is `<ID>.png`, so this only has to catch
    // an `images` folder that is itself a link out of the package.
    let images = fs::canonicalize(root.join(IMAGES_DIR)).unwrap_or_else(|_| root.join(IMAGES_DIR));
    let file = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !file.starts_with(&images) {
        return Err(ProjectError::Invalid);
    }
    Ok(())
}

/// An empty project folder, ready to have layers added.
pub fn create(root: impl AsRef<Path>, width: u32, height: u32, limits: &Limits) -> Result<Project, ProjectError> {
    let manifest = Manifest::new(width, height);
    save(root.as_ref(), &manifest, &PackageAssets::new(), limits)?;
    load(root, limits)
}

/// The file a layer's pixels belong in, relative to the package.
pub fn image_relative_path(layer: Uuid) -> PathBuf {
    PathBuf::from(IMAGES_DIR).join(AssetKind::Image.file_name(layer))
}

/// The file a layer's mask belongs in, relative to the package.
pub fn mask_relative_path(layer: Uuid) -> PathBuf {
    PathBuf::from(IMAGES_DIR).join(AssetKind::Mask.file_name(layer))
}
