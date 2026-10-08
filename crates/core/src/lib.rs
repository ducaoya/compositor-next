//! Compositor's `.comp` project format, as a library.
//!
//! This crate is the compatibility contract. A `.comp` written here must open in the macOS app and
//! the other way round, so the schema in [`manifest`] mirrors its Swift `Codable` synthesis exactly
//! and [`validate`] mirrors its validator rule for rule, version gating included.
//!
//! Pixels are never decoded here: [`package::load`] returns the manifest plus each asset's path and
//! size, and the caller decides how to read them. The webview decodes PNGs straight into GPU
//! textures, so decoding in Rust would only copy the same bytes twice.
//!
//! ```no_run
//! use compositor_core::{limits::Limits, package};
//!
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let limits = Limits::default();
//! let project = package::load("~/Desktop/Demo.comp", &limits)?;
//! println!("{} × {}, {} layers", project.manifest.width, project.manifest.height, project.manifest.layers.len());
//! # Ok(())
//! # }
//! ```

pub mod error;
pub mod limits;
pub mod manifest;
pub mod package;
pub mod png;
pub mod sysmem;
pub mod validate;

pub use error::{AssetFile, AssetKind, PackageAssets, Project, ProjectError};
pub use limits::Limits;
pub use manifest::{
    BlendMode, Guide, GuideAxis, Header, LayerRecord, Manifest, Sampling, Transform, COLOR_SPACE,
    CURRENT_VERSION, FORMAT_ID, MIN_VERSION,
};

/// Reads a project with the default limits.
pub fn load(root: impl AsRef<std::path::Path>) -> Result<Project, ProjectError> {
    package::load(root, &Limits::default())
}

/// Writes a project with the default limits.
pub fn save(
    root: impl AsRef<std::path::Path>,
    manifest: &Manifest,
    assets: &PackageAssets,
) -> Result<(), ProjectError> {
    package::save(root, manifest, assets, &Limits::default())
}
