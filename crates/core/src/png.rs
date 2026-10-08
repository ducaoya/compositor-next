//! Just enough PNG to read a header.
//!
//! The package loader needs a PNG's dimensions and colour type before it decodes anything, and the
//! reference app checks exactly these: 8-bit PNGs, RGBA for pixels, grayscale for masks. Reading
//! IHDR directly keeps this crate free of a decoder dependency.

/// The 8 bytes every PNG starts with.
const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

pub const COLOR_TYPE_GRAYSCALE: u8 = 0;
pub const COLOR_TYPE_RGB: u8 = 2;
pub const COLOR_TYPE_PALETTE: u8 = 3;
pub const COLOR_TYPE_GRAY_ALPHA: u8 = 4;
pub const COLOR_TYPE_RGBA: u8 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PngHeader {
    pub width: u32,
    pub height: u32,
    /// Bits per channel: 1, 2, 4, 8 or 16.
    pub bit_depth: u8,
    pub color_type: u8,
}

impl PngHeader {
    /// Whether this is an 8-bit grayscale image with no alpha, which is what a mask must be.
    pub fn is_mask(&self) -> bool {
        self.bit_depth == 8 && self.color_type == COLOR_TYPE_GRAYSCALE
    }

    /// Whether the reference app would accept this as layer pixels: at most 8 bits deep.
    pub fn is_layer_pixels(&self) -> bool {
        self.bit_depth <= 8
            && matches!(
                self.color_type,
                COLOR_TYPE_GRAYSCALE
                    | COLOR_TYPE_RGB
                    | COLOR_TYPE_PALETTE
                    | COLOR_TYPE_GRAY_ALPHA
                    | COLOR_TYPE_RGBA
            )
    }
}

/// Reads the IHDR chunk. `None` if this is not a PNG or the header is truncated.
pub fn header(bytes: &[u8]) -> Option<PngHeader> {
    if bytes.len() < 33 || bytes[0..8] != SIGNATURE {
        return None;
    }
    // The first chunk must be IHDR, 13 bytes long.
    let length = u32::from_be_bytes(bytes[8..12].try_into().ok()?);
    if length != 13 || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    let bit_depth = bytes[24];
    let color_type = bytes[25];
    let compression = bytes[26];
    let filter = bytes[27];
    let interlace = bytes[28];
    if compression != 0 || filter != 0 || interlace > 1 {
        return None;
    }
    Some(PngHeader { width, height, bit_depth, color_type })
}
