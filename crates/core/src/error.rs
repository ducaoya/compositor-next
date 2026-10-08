use std::path::PathBuf;

use crate::{limits::MAX_MANIFEST_BYTES, Manifest};

pub const SUPPORTED_FIRST: u32 = crate::MIN_VERSION;
pub const SUPPORTED_LAST: u32 = crate::CURRENT_VERSION;

/// Everything that can go wrong reading or writing a `.comp`.
#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("this is not a valid Compositor project, or its metadata is damaged")]
    Invalid,

    #[error(
        "this project uses format version {0}; this app supports versions \
         {SUPPORTED_FIRST}–{SUPPORTED_LAST}"
    )]
    Version(u32),

    #[error("an image inside the project is missing or damaged. The current document has not been replaced")]
    MissingImage,

    #[error(
        "this project exceeds the supported canvas, layer, file-size, or {0}-megapixel document limit"
    )]
    TooLarge(u64),

    #[error("an image could not be saved. The previous project has not been replaced")]
    Encode,

    #[error("no file or folder at {0}")]
    NotFound(PathBuf),

    /// A failure the manifest validator found, carrying the offending layer when there is one.
    #[error("{reason}")]
    Rule { reason: String, layer: Option<uuid::Uuid> },

    #[error("{0}")]
    Io(#[from] std::io::Error),

    #[error("metadata is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
}

impl ProjectError {
    pub(crate) fn rule(reason: impl Into<String>) -> Self {
        Self::Rule { reason: reason.into(), layer: None }
    }

    pub(crate) fn layer_rule(layer: uuid::Uuid, reason: impl Into<String>) -> Self {
        Self::Rule { reason: reason.into(), layer: Some(layer) }
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
