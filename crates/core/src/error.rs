use std::path::PathBuf;

use crate::{limits::MAX_MANIFEST_BYTES, Manifest};

pub const SUPPORTED_FIRST: u32 = crate::MIN_VERSION;
pub const SUPPORTED_LAST: u32 = crate::CURRENT_VERSION;

/// Everything that can go wrong reading or writing a `.comp`.
///
/// Each case carries **no prose**: the message a reader sees comes from the language pack, keyed by
/// the variant. Two exceptions are deliberate. `Rule` carries a `code` naming which rule broke,
/// which the frontend looks up as `error.rule.<code>`. `Io` and `Json` wrap failures from the
/// platform, which have no translation and are shown as they come.
#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("error.invalid")]
    Invalid,

    #[error("error.version")]
    Version(u32),

    #[error("error.missingImage")]
    MissingImage,

    #[error("error.tooLarge")]
    TooLarge(u64),

    #[error("error.encode")]
    Encode,

    #[error("error.notFound")]
    NotFound(PathBuf),

    /// A manifest rule, named by `code` and stamped with the layer that broke it when there is one.
    #[error("error.rule.{code}")]
    Rule { code: &'static str, layer: Option<uuid::Uuid> },

    #[error("error.io")]
    Io(#[from] std::io::Error),

    #[error("error.json")]
    Json(#[from] serde_json::Error),
}

impl ProjectError {
    /// The rule that broke, with no layer attached.
    pub(crate) fn rule(code: &'static str) -> Self {
        Self::Rule { code, layer: None }
    }

    /// The rule that broke on one layer, so the UI can point at it.
    pub(crate) fn layer_rule(layer: uuid::Uuid, code: &'static str) -> Self {
        Self::Rule { code, layer: Some(layer) }
    }

    /// The translation key, without the `error.` prefix.
    pub fn code(&self) -> &str {
        match self {
            ProjectError::Invalid => "invalid",
            ProjectError::Version(_) => "version",
            ProjectError::MissingImage => "missingImage",
            ProjectError::TooLarge(_) => "tooLarge",
            ProjectError::Encode => "encode",
            ProjectError::NotFound(_) => "notFound",
            ProjectError::Rule { code, .. } => code,
            ProjectError::Io(_) => "io",
            ProjectError::Json(_) => "json",
        }
    }

    /// The full translation key: `error.*` for the general cases, `error.rule.*` for the rules.
    pub fn message_key(&self) -> String {
        match self {
            ProjectError::Rule { code, .. } => format!("error.rule.{code}"),
            other => format!("error.{}", other.code()),
        }
    }

    /// Values for the key's placeholders.
    pub fn params(&self) -> serde_json::Value {
        use serde_json::json;
        match self {
            ProjectError::Version(version) => json!({
                "version": version,
                "min": SUPPORTED_FIRST,
                "max": SUPPORTED_LAST,
            }),
            ProjectError::TooLarge(megapixels) => json!({ "megapixels": megapixels }),
            ProjectError::NotFound(path) => json!({ "path": path.to_string_lossy() }),
            ProjectError::Rule { layer, .. } => json!({ "layer": layer.map(|id| id.to_string()) }),
            ProjectError::Io(error) => json!({ "message": error.to_string() }),
            ProjectError::Json(error) => json!({ "message": error.to_string() }),
            _ => json!({}),
        }
    }
}

/// A manifest plus the asset bytes that belong to it, as written to disk.
#[derive(Debug, Clone)]
pub struct PackageAssets {
    pub files: std::collections::BTreeMap<(uuid::Uuid, AssetKind), Vec<u8>>,
}

impl PackageAssets {
    pub fn new() -> Self {
        Self { files: Default::default() }
    }

    pub fn insert(&mut self, layer: uuid::Uuid, kind: AssetKind, bytes: Vec<u8>) {
        self.files.insert((layer, kind), bytes);
    }
}

impl Default for PackageAssets {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AssetKind {
    /// A layer's pixels, `images/<ID>.png`.
    Image,
    /// A layer's mask, `images/<ID>.mask.png`.
    Mask,
}

impl AssetKind {
    pub fn file_name(self, layer: uuid::Uuid) -> String {
        let id = layer.hyphenated().to_string().to_uppercase();
        match self {
            AssetKind::Image => format!("{id}.png"),
            AssetKind::Mask => format!("{id}.mask.png"),
        }
    }

    /// The file name a manifest must use for this layer and kind.
    pub fn required_file_name(self, layer: uuid::Uuid) -> String {
        self.file_name(layer)
    }
}

/// Where an asset actually lives, and how big its pixels are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetFile {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
}

/// A loaded project: the manifest plus where each layer's pixels are on disk.
///
/// Pixels are deliberately *not* decoded here. The webview can decode PNGs straight off disk into
/// GPU textures, so decoding in Rust would only copy the same bytes twice.
#[derive(Debug, Clone)]
pub struct Project {
    pub manifest: Manifest,
    pub images: std::collections::HashMap<uuid::Uuid, AssetFile>,
    pub masks: std::collections::HashMap<uuid::Uuid, AssetFile>,
    /// The folder the project was read from: `<path>/manifest.json`'s parent.
    pub root: PathBuf,
}

impl Project {
    pub fn asset(&self, layer: uuid::Uuid, kind: AssetKind) -> Option<&AssetFile> {
        match kind {
            AssetKind::Image => self.images.get(&layer),
            AssetKind::Mask => self.masks.get(&layer),
        }
    }
}

/// The manifest size ceiling, re-exported so callers do not reach into `limits`.
pub fn manifest_ceiling() -> u64 {
    MAX_MANIFEST_BYTES
}
