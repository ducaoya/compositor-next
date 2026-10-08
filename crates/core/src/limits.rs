//! The size and memory ceilings a document is held to.
//!
//! Two separate ideas share this file, as in the reference app: how large a *single* surface may
//! be, and how much raster a *whole document* may hold across all of its layers. A 58-megapixel
//! banner with 29 layers is ordinary, and it needs far more than one surface's worth of allowance
//! even though no single surface in it is unusual.

use crate::sysmem;

/// Longest side, in pixels, of any canvas, layer, mask or generated surface.
pub const MAX_SIDE: u32 = 30_000;

/// Largest single surface: a canvas, an export, a filter target, an adjustment or mask render.
/// At RGBA8 one allocation is at most 800 MB, and a filter holds a few at once.
pub const MAX_SURFACE_PIXELS: u64 = 200_000_000;

/// Layers, including folders. `layers.count <= 10_000` in the reference validator.
pub const MAX_LAYERS: usize = 10_000;

/// The manifest's own size ceiling.
pub const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

/// One encoded asset's ceiling.
pub const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;

/// At most this many alignment guides.
pub const MAX_GUIDES: usize = 1_000;

/// How deep folders may nest.
pub const MAX_NESTING: usize = 64;

/// How long a clipping-mask chain may be.
pub const MAX_CLIP_CHAIN: usize = 256;

/// Layer names are capped at this many UTF-8 bytes.
pub const MAX_NAME_BYTES: usize = 16_384;

/// The ceilings in one value, so tests can pin them and the resolver can raise the memory budget.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_side: u32,
    pub max_surface_pixels: u64,
    pub max_layers: usize,
    pub max_guides: usize,
    pub max_nesting: usize,
    pub max_clip_chain: usize,
    pub max_name_bytes: usize,
    pub manifest_bytes: u64,
    pub asset_bytes: u64,
    /// Total imported raster one document may hold, across every layer and mask.
    pub document_pixel_budget: u64,
}

impl Default for Limits {
    fn default() -> Self {
        // A quarter of the machine's memory at 4 bytes a pixel, never below one surface and never
        // above 800 MP (3.2 GB of layers).
        let budget = match sysmem::total_memory() {
            Some(bytes) => (bytes / 16).clamp(MAX_SURFACE_PIXELS, 800_000_000),
            None => MAX_SURFACE_PIXELS,
        };
        Self {
            max_side: MAX_SIDE,
            max_surface_pixels: MAX_SURFACE_PIXELS,
            max_layers: MAX_LAYERS,
            max_guides: MAX_GUIDES,
            max_nesting: MAX_NESTING,
            max_clip_chain: MAX_CLIP_CHAIN,
            max_name_bytes: MAX_NAME_BYTES,
            manifest_bytes: MAX_MANIFEST_BYTES,
            asset_bytes: MAX_ASSET_BYTES,
            document_pixel_budget: budget,
        }
    }
}

impl Limits {
    /// The budget in whole megapixels, for the messages that quote it back.
    pub fn document_budget_megapixels(&self) -> u64 {
        self.document_pixel_budget / 1_000_000
    }

    pub fn max_surface_megapixels(&self) -> u64 {
        self.max_surface_pixels / 1_000_000
    }
}
