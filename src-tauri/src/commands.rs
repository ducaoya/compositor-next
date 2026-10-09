//! The commands the webview can call.
//!
//! Every one of them is a coarse, low-frequency operation. Nothing here runs per frame.

use std::fs;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use compositor_core::{
    error::{AssetKind, ProjectError}, limits::Limits, manifest::{BlendMode, Manifest}, package,
};
use serde::Serialize;
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, State,
};

use crate::state::{self, SaveSessions, StartupProject};

/// A failure the frontend can translate.
///
/// Rust never builds user-facing prose. It names the failure and supplies the values, and the
/// language pack says it — otherwise every message would be English no matter which language the
/// interface is in.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    /// A translation key, such as `error.missingImage` or `error.rule.duplicateLayerId`.
    pub key: String,
    /// Values for the key's placeholders.
    pub params: serde_json::Value,
    /// Shown when the key is not translated. Only the platform's own failures get one worth
    /// reading; everything else keys off `key`.
    pub fallback: String,
}

impl CommandError {
    pub(crate) fn new(key: impl Into<String>, fallback: impl Into<String>) -> Self {
        Self { key: key.into(), params: serde_json::json!({}), fallback: fallback.into() }
    }
}

impl From<ProjectError> for CommandError {
    fn from(error: ProjectError) -> Self {
        // A rule's `Display` is its own translation key, which is a poor thing to show, so a rule
        // falls back to its code and lets the language pack say the rest.
        let fallback = match &error {
            ProjectError::Rule { code, .. } => (*code).to_string(),
            other => other.to_string(),
        };
        Self { key: error.message_key(), params: error.params(), fallback }
    }
}

impl From<std::io::Error> for CommandError {
    fn from(error: std::io::Error) -> Self {
        Self { key: "error.io".into(), params: serde_json::json!({ "message": error.to_string() }), fallback: error.to_string() }
    }
}

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
pub fn open_project(app: AppHandle, path: String) -> Result<OpenedProject, CommandError> {
    describe(&app, &path).map_err(CommandError::from)
}

/// The project the shell was asked to open, when this launch came from a double-click.
///
/// Answered once. A cold start arrives by this call and a second launch of the same file arrives as
/// the `project:open` event instead, so neither path runs twice for one double-click — opening a
/// project that is already open would give two tabs writing to one package.
#[tauri::command]
pub fn startup_project(state: State<'_, StartupProject>) -> Option<String> {
    state.take()
}

/// Makes an empty project on disk, then opens it.
#[tauri::command]
pub fn create_project(
    app: AppHandle,
    path: String,
    width: u32,
    height: u32,
) -> Result<OpenedProject, CommandError> {
    package::create(&path, width, height, &state::limits()).map_err(CommandError::from)?;
    describe(&app, &path).map_err(CommandError::from)
}

/// Starts a save: makes the staging folder and returns its session id.
#[tauri::command]
pub fn begin_save(state: State<'_, SaveSessions>, target: String) -> Result<String, CommandError> {
    let target = std::path::PathBuf::from(target);
    let staging = package::staging_directory(&target).map_err(CommandError::from)?;
    Ok(state.begin(target, staging))
}

/// Writes one PNG into the staging folder. The bytes are the raw IPC body.
///
/// Headers: `x-session` (from `begin_save`), `x-name` (the file name the manifest will declare).
#[tauri::command]
pub fn write_asset(state: State<'_, SaveSessions>, request: Request<'_>) -> Result<(), CommandError> {
    let session = header(&request, "x-session")?;
    let name = header(&request, "x-name")?;
    if !is_safe_asset_name(&name) {
        return Err(CommandError::new("error.assetFileName", &name));
    }
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandError::new("error.expectedRawBody", "expected the PNG as a raw body"));
    };
    if compositor_core::png::header(bytes).is_none() {
        return Err(CommandError::new("error.notPng", &name));
    }
    let staging = state.staging(&session).ok_or_else(|| CommandError::new("error.saveEnded", &session))?;
    fs::write(staging.join(package::IMAGES_DIR).join(&name), bytes).map_err(CommandError::from)
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
) -> Result<(), CommandError> {
    if !is_safe_asset_name(&name) {
        return Err(CommandError::new("error.assetFileName", &name));
    }
    let staging = state.staging(&session).ok_or_else(|| CommandError::new("error.saveEnded", &session))?;
    let source = std::path::PathBuf::from(source);
    if !source.is_file() {
        return Err(CommandError::new("error.notFound", source.to_string_lossy()));
    }
    fs::copy(&source, staging.join(package::IMAGES_DIR).join(&name)).map_err(CommandError::from)?;
    Ok(())
}

/// Validates the staged package, writes its manifest, and swaps it in over the target.
#[tauri::command]
pub fn commit_save(
    state: State<'_, SaveSessions>,
    session: String,
    manifest: serde_json::Value,
) -> Result<(), CommandError> {
    let entry = state.take(&session).ok_or_else(|| CommandError::new("error.saveEnded", &session))?;
    let manifest: Manifest = serde_json::from_value(manifest).map_err(|error| {
        CommandError::new("error.notAManifest", error.to_string())
    })?;
    package::save_staged(entry.staging(), entry.target(), &manifest, &state::limits())
        .map_err(CommandError::from)
}

/// Throws away a save that was started and not committed.
#[tauri::command]
pub fn abort_save(state: State<'_, SaveSessions>, session: String) -> Result<(), CommandError> {
    let Some(entry) = state.take(&session) else { return Ok(()) };
    let _ = fs::remove_dir_all(entry.staging());
    Ok(())
}

/// Writes one file anywhere, for exports. The bytes are the raw IPC body, and `x-path` carries
/// the destination as base64url so paths with non-ASCII characters survive.
#[tauri::command]
pub fn write_file(request: Request<'_>) -> Result<(), CommandError> {
    let encoded = header(&request, "x-path")?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| CommandError::new("error.badHeader", "x-path is not valid base64url"))?;
    let path = String::from_utf8(decoded).map_err(|_| CommandError::new("error.badHeader", "x-path is not UTF-8"))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandError::new("error.expectedRawBody", "expected the file as a raw body"));
    };
    let path = std::path::PathBuf::from(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(CommandError::from)?;
    }
    fs::write(&path, bytes).map_err(CommandError::from)
}

/// Reads a file and answers with its bytes as a raw body.
///
/// Used for imported images, whether they came from a picker or were dropped on the window. Going
/// through `Response` rather than a JSON array keeps a 40 MB photograph from arriving as 40 million
/// numbers.
#[tauri::command]
pub fn read_file(path: String) -> Result<tauri::ipc::Response, CommandError> {
    let bytes = fs::read(&path).map_err(|_| CommandError::new("error.notFound", &path))?;
    Ok(tauri::ipc::Response::new(bytes))
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

// MARK: - Language packs

/// Where installed packs live: the app's data folder, so installing one is copying a file and
/// nothing has to be rebuilt or downloaded.
fn languages_dir(app: &AppHandle) -> Result<std::path::PathBuf, CommandError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| CommandError::new("error.io", error.to_string()))?
        .join("languages");
    fs::create_dir_all(&dir).map_err(CommandError::from)?;
    Ok(dir)
}

/// Every installed pack, parsed.
#[tauri::command]
pub fn list_language_packs(app: AppHandle) -> Result<Vec<serde_json::Value>, CommandError> {
    let dir = languages_dir(&app)?;
    let mut packs = Vec::new();
    for entry in fs::read_dir(&dir).map_err(CommandError::from)?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        // A pack that does not parse is skipped rather than failing the whole listing: one broken
        // file should not cost the user every other language.
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        if check_pack(&value).is_ok() {
            packs.push(value);
        }
    }
    Ok(packs)
}

/// Installs a pack from a file the user chose, returning what was installed.
#[tauri::command]
pub fn install_language_pack(app: AppHandle, path: String) -> Result<serde_json::Value, CommandError> {
    let source = std::path::PathBuf::from(&path);
    let text = fs::read_to_string(&source)
        .map_err(|_| CommandError::new("error.notFound", path.clone()))?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|error| {
        CommandError { key: "language.installedError".into(), params: serde_json::json!({ "reason": error.to_string() }), fallback: error.to_string() }
    })?;
    let locale = check_pack(&value).map_err(|reason| CommandError {
        key: "language.installedError".into(),
        params: serde_json::json!({ "reason": reason }),
        fallback: reason,
    })?;

    let target = languages_dir(&app)?.join(format!("{locale}.json"));
    fs::write(&target, text).map_err(CommandError::from)?;
    Ok(value)
}

/// Opens the folder packs are installed into, so one can be dropped in by hand.
#[tauri::command]
pub fn open_language_folder(app: AppHandle) -> Result<String, CommandError> {
    use tauri_plugin_opener::OpenerExt;
    let dir = languages_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| CommandError::new("error.io", error.to_string()))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Checks the three fields a pack cannot do without. Everything else is optional, because a pack
/// that translates some of the interface is worth having on the day it is started.
fn check_pack(value: &serde_json::Value) -> Result<String, String> {
    let Some(object) = value.as_object() else {
        return Err("the file does not contain a JSON object".into());
    };
    let locale = object.get("locale").and_then(|v| v.as_str()).unwrap_or_default().trim();
    if locale.is_empty() {
        return Err("there is no \"locale\"".into());
    }
    if locale.contains(['/', '\\', ':', '.']) {
        return Err("the locale may not contain a path separator".into());
    }
    if object.get("name").and_then(|v| v.as_str()).unwrap_or_default().trim().is_empty() {
        return Err("there is no \"name\"".into());
    }
    if !object.get("messages").map(|v| v.is_object()).unwrap_or(false) {
        return Err("there is no \"messages\" object".into());
    }
    Ok(locale.to_string())
}

// MARK: - Helpers

fn describe(app: &AppHandle, path: &str) -> Result<OpenedProject, compositor_core::ProjectError> {
    let project = state::load(path)?;
    // Only the project's own folder is reachable over the asset protocol, and only after it has
    // been opened — recursively, because a layer's pixels live one level down in `images/` and a
    // scope that stopped at the folder would refuse every one of them.
    let _ = app.asset_protocol_scope().allow_directory(&project.root, true);

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

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<String, CommandError> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| CommandError::new("error.badHeader", format!("missing {name}")))
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
