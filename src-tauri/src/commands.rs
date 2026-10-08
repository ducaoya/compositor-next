//! The commands the webview can call.
//!
//! Every one of them is a coarse, low-frequency operation. Nothing here runs per frame.

use std::fs;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use compositor_core::{
    error::AssetKind, limits::Limits, manifest::{BlendMode, Manifest}, package,
};
use serde::Serialize;
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, State,
};

use crate::state::{self, SaveSessions};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetEntry {
    pub layer_id: String,
    /// `image` or `mask`.
    pub kind: &'static str,
    pub name: String,
    /// Absolute path. The frontend turns it into a URL with `convertFileSrc`.
    pub path: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedProject {
    pub path: String,
    pub manifest: Manifest,
    pub assets: Vec<AssetEntry>,
}

/// Reads a `.comp`, and opens the asset protocol on its folder so the webview can load the PNGs.
#[tauri::command]
pub fn open_project(app: AppHandle, path: String) -> Result<OpenedProject, String> {
    describe(&app, &path).map_err(|error| error.to_string())
}

/// Makes an empty project on disk, then opens it.
#[tauri::command]
pub fn create_project(
    app: AppHandle,
    path: String,
    width: u32,
    height: u32,
) -> Result<OpenedProject, String> {
    package::create(&path, width, height, &state::limits()).map_err(|error| error.to_string())?;
    describe(&app, &path).map_err(|error| error.to_string())
}

/// Starts a save: makes the staging folder and returns its session id.
#[tauri::command]
pub fn begin_save(state: State<'_, SaveSessions>, target: String) -> Result<String, String> {
    let target = std::path::PathBuf::from(target);
    let staging = package::staging_directory(&target).map_err(|error| error.to_string())?;
    Ok(state.begin(target, staging))
}

/// Writes one PNG into the staging folder. The bytes are the raw IPC body.
///
/// Headers: `x-session` (from `begin_save`), `x-name` (the file name the manifest will declare).
#[tauri::command]
pub fn write_asset(state: State<'_, SaveSessions>, request: Request<'_>) -> Result<(), String> {
    let session = header(&request, "x-session")?;
    let name = header(&request, "x-name")?;
    if !is_safe_asset_name(&name) {
        return Err(format!("{name} is not a layer file name"));
    }
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the PNG as a raw body".into());
    };
    if compositor_core::png::header(bytes).is_none() {
        return Err(format!("{name} is not a PNG"));
    }
    let staging = state.staging(&session).ok_or("that save session has ended")?;
    fs::write(staging.join(package::IMAGES_DIR).join(&name), bytes).map_err(|error| error.to_string())
}

/// Copies a file the project already has into the staging folder.
///
/// Saving a project that was only opened never round-trips a PNG through the webview: the bytes
/// are already on disk, next to the folder being written.
#[tauri::command]
pub fn link_asset(
    state: State<'_, SaveSessions>,
    session: String,
    name: String,
    source: String,
) -> Result<(), String> {
    if !is_safe_asset_name(&name) {
        return Err(format!("{name} is not a layer file name"));
    }
    let staging = state.staging(&session).ok_or("that save session has ended")?;
    let source = std::path::PathBuf::from(source);
    if !source.is_file() {
        return Err(format!("{} is no longer there", source.display()));
    }
    fs::copy(&source, staging.join(package::IMAGES_DIR).join(&name)).map_err(|error| error.to_string())?;
    Ok(())
}

/// Validates the staged package, writes its manifest, and swaps it in over the target.
#[tauri::command]
pub fn commit_save(
    state: State<'_, SaveSessions>,
    session: String,
    manifest: serde_json::Value,
) -> Result<(), String> {
    let entry = state.take(&session).ok_or("that save session has ended")?;
    let manifest: Manifest = serde_json::from_value(manifest)
        .map_err(|error| format!("the document is not a valid manifest: {error}"))?;
    package::save_staged(entry.staging(), entry.target(), &manifest, &state::limits())
        .map_err(|error| error.to_string())
}

/// Throws away a save that was started and not committed.
#[tauri::command]
pub fn abort_save(state: State<'_, SaveSessions>, session: String) -> Result<(), String> {
    let Some(entry) = state.take(&session) else { return Ok(()) };
    let _ = fs::remove_dir_all(entry.staging());
    Ok(())
}

/// Writes one file anywhere, for exports. The bytes are the raw IPC body, and `x-path` carries
/// the destination as base64url so paths with non-ASCII characters survive.
#[tauri::command]
pub fn write_file(request: Request<'_>) -> Result<(), String> {
    let encoded = header(&request, "x-path")?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| "x-path is not valid base64url")?;
    let path = String::from_utf8(decoded).map_err(|_| "x-path is not UTF-8")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file as a raw body".into());
    };
    let path = std::path::PathBuf::from(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, bytes).map_err(|error| error.to_string())
}

/// The ceilings the app is running with, so the UI can quote them back.
#[tauri::command]
pub fn read_app_limits() -> LimitsView {
    let limits = Limits::default();
    LimitsView {
        max_side: limits.max_side,
        max_surface_pixels: limits.max_surface_pixels,
        max_layers: limits.max_layers,
        document_pixel_budget: limits.document_pixel_budget,
        current_version: compositor_core::CURRENT_VERSION,
        supported_versions: (compositor_core::MIN_VERSION, compositor_core::CURRENT_VERSION),
    }
}

/// The blend modes, straight from the crate that owns the names. The frontend uses this to prove
/// its own list has not drifted.
#[tauri::command]
pub fn blend_modes() -> Vec<BlendModeView> {
    BlendMode::ALL
        .iter()
        .map(|mode| BlendModeView { name: mode.label(), group: mode.group() })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsView {
    pub max_side: u32,
    pub max_surface_pixels: u64,
    pub max_layers: usize,
    pub document_pixel_budget: u64,
    pub current_version: u32,
    pub supported_versions: (u32, u32),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlendModeView {
    pub name: &'static str,
    pub group: u8,
}

fn describe(app: &AppHandle, path: &str) -> Result<OpenedProject, compositor_core::ProjectError> {
    let project = state::load(path)?;
    // Only the project's own folder is reachable over the asset protocol, and only after it has
    // been opened.
    let _ = app.asset_protocol_scope().allow_directory(&project.root, false);

    let mut assets = Vec::new();
    for layer in &project.manifest.layers {
        for kind in [AssetKind::Image, AssetKind::Mask] {
            let Some(asset) = project.asset(layer.id, kind) else { continue };
            assets.push(AssetEntry {
                layer_id: layer.id.hyphenated().to_string().to_uppercase(),
                kind: match kind {
                    AssetKind::Image => "image",
                    AssetKind::Mask => "mask",
                },
                name: asset
                    .path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: asset.path.to_string_lossy().into_owned(),
                width: asset.width,
                height: asset.height,
            });
        }
    }

    Ok(OpenedProject {
        path: project.root.to_string_lossy().into_owned(),
        manifest: project.manifest,
        assets,
    })
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<String, String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| format!("missing {name}"))
}

/// A name a project's `images/` folder may hold: `<UUID>.png` or `<UUID>.mask.png`, ASCII only.
///
/// Checking this here is what keeps `write_asset` from being talked into writing outside the
/// staging folder.
fn is_safe_asset_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.ends_with(".png")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
}
