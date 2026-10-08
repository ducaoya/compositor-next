//! The `.comp` manifest, versions 1–11.
//!
//! Field names and encodings follow Compositor's Swift `Codable` synthesis exactly, so a project
//! written here opens there and the other way round. Two details are easy to get wrong:
//!
//! * `CGPoint` and `CGSize` encode as **arrays**, not objects: `"origin": [0, 0]`.
//! * `UUID` encodes **uppercase**: `"0C5E7A91-3B2D-4F6A-8E1C-9D0B7A6F5E4D"`. Reading accepts
//!   either case; writing always uppercases.
//!
//! Fields this crate does not model yet (`adjustment`, `effects`, `text`, `shape`) are kept as
//! `serde_json::Value` so a project round-trips without losing them. That is deliberately more
//! permissive than the reference app, which drops what it does not understand.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const FORMAT_ID: &str = "com.compositor.project";
pub const CURRENT_VERSION: u32 = 11;
pub const MIN_VERSION: u32 = 1;
pub const COLOR_SPACE: &str = "sRGB";

/// A UUID written the way Compositor writes it: uppercase, hyphenated.
mod uuid_upper {
    use serde::{Deserialize, Deserializer, Serializer};
    use uuid::Uuid;

    pub fn serialize<S: Serializer>(value: &Uuid, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.hyphenated().to_string().to_uppercase())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Uuid, D::Error> {
        let text = String::deserialize(deserializer)?;
        Uuid::parse_str(text.trim()).map_err(serde::de::Error::custom)
    }
}

/// `Option<Uuid>` with the same casing rules.
mod uuid_upper_opt {
    use serde::{Deserialize, Deserializer, Serializer};
    use uuid::Uuid;

    pub fn serialize<S: Serializer>(value: &Option<Uuid>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(id) => serializer.serialize_some(&id.hyphenated().to_string().to_uppercase()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Uuid>, D::Error> {
        match Option::<String>::deserialize(deserializer)? {
            Some(text) => Uuid::parse_str(text.trim())
                .map(Some)
                .map_err(serde::de::Error::custom),
            None => Ok(None),
        }
    }
}

fn default_true() -> bool {
    true
}

/// Photoshop's blend modes, in the order Compositor stores them.
///
/// The strings are the contract: agents and the reference app match them exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum BlendMode {
    Normal,
    Darken,
    Multiply,
    #[serde(rename = "Color Burn")]
    ColorBurn,
    #[serde(rename = "Linear Burn")]
    LinearBurn,
    Lighten,
    Screen,
    #[serde(rename = "Color Dodge")]
    ColorDodge,
    #[serde(rename = "Linear Dodge (Add)")]
    LinearDodge,
    Overlay,
    #[serde(rename = "Soft Light")]
    SoftLight,
    #[serde(rename = "Hard Light")]
    HardLight,
    #[serde(rename = "Vivid Light")]
    VividLight,
    #[serde(rename = "Linear Light")]
    LinearLight,
    #[serde(rename = "Pin Light")]
    PinLight,
    #[serde(rename = "Hard Mix")]
    HardMix,
    Difference,
    Exclusion,
    Subtract,
    Divide,
    Hue,
    Saturation,
    Color,
    Luminosity,
}

impl Default for BlendMode {
    fn default() -> Self {
        Self::Normal
    }
}

impl BlendMode {
    pub const ALL: [BlendMode; 24] = [
        BlendMode::Normal,
        BlendMode::Darken,
        BlendMode::Multiply,
        BlendMode::ColorBurn,
        BlendMode::LinearBurn,
        BlendMode::Lighten,
        BlendMode::Screen,
        BlendMode::ColorDodge,
        BlendMode::LinearDodge,
        BlendMode::Overlay,
        BlendMode::SoftLight,
        BlendMode::HardLight,
        BlendMode::VividLight,
        BlendMode::LinearLight,
        BlendMode::PinLight,
        BlendMode::HardMix,
        BlendMode::Difference,
        BlendMode::Exclusion,
        BlendMode::Subtract,
        BlendMode::Divide,
        BlendMode::Hue,
        BlendMode::Saturation,
        BlendMode::Color,
        BlendMode::Luminosity,
    ];

    /// Photoshop's grouping, used to draw separators in the mode picker.
    pub fn group(self) -> u8 {
        match self {
            BlendMode::Normal => 0,
            BlendMode::Darken | BlendMode::Multiply | BlendMode::ColorBurn | BlendMode::LinearBurn => 1,
            BlendMode::Lighten | BlendMode::Screen | BlendMode::ColorDodge | BlendMode::LinearDodge => 2,
            BlendMode::Overlay
            | BlendMode::SoftLight
            | BlendMode::HardLight
            | BlendMode::VividLight
            | BlendMode::LinearLight
            | BlendMode::PinLight
            | BlendMode::HardMix => 3,
            BlendMode::Difference | BlendMode::Exclusion | BlendMode::Subtract | BlendMode::Divide => 4,
            BlendMode::Hue | BlendMode::Saturation | BlendMode::Color | BlendMode::Luminosity => 5,
        }
    }

    /// The display name the picker shows.
    pub fn label(self) -> &'static str {
        match self {
            BlendMode::Normal => "Normal",
            BlendMode::Darken => "Darken",
            BlendMode::Multiply => "Multiply",
            BlendMode::ColorBurn => "Color Burn",
            BlendMode::LinearBurn => "Linear Burn",
            BlendMode::Lighten => "Lighten",
            BlendMode::Screen => "Screen",
            BlendMode::ColorDodge => "Color Dodge",
            BlendMode::LinearDodge => "Linear Dodge (Add)",
            BlendMode::Overlay => "Overlay",
            BlendMode::SoftLight => "Soft Light",
            BlendMode::HardLight => "Hard Light",
            BlendMode::VividLight => "Vivid Light",
            BlendMode::LinearLight => "Linear Light",
            BlendMode::PinLight => "Pin Light",
            BlendMode::HardMix => "Hard Mix",
            BlendMode::Difference => "Difference",
            BlendMode::Exclusion => "Exclusion",
            BlendMode::Subtract => "Subtract",
            BlendMode::Divide => "Divide",
            BlendMode::Hue => "Hue",
            BlendMode::Saturation => "Saturation",
            BlendMode::Color => "Color",
            BlendMode::Luminosity => "Luminosity",
        }
    }
}

/// How a layer's pixels are resampled when its transform scales them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Sampling {
    Nearest,
    Smooth,
    #[serde(rename = "High quality")]
    High,
}

impl Default for Sampling {
    fn default() -> Self {
        Self::High
    }
}

/// Where a layer sits on the document, in document pixels.
///
/// `origin` is the top-left corner and `size` the placed width and height: the image is stretched
/// to `size`, so a layer can be a cut-out smaller than the canvas.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Transform {
    pub origin: [f64; 2],
    pub size: [f64; 2],
    #[serde(default)]
    pub rotation: f64,
    #[serde(default, rename = "flipX")]
    pub flip_x: bool,
    #[serde(default, rename = "flipY")]
    pub flip_y: bool,
    #[serde(default)]
    pub sampling: Sampling,
}

impl Transform {
    /// A layer covering `width` × `height` at the origin, the shape a fresh import gets.
    pub fn covering(width: u32, height: u32) -> Self {
        Self {
            origin: [0.0, 0.0],
            size: [width as f64, height as f64],
            rotation: 0.0,
            flip_x: false,
            flip_y: false,
            sampling: Sampling::High,
        }
    }

    pub fn center(&self) -> [f64; 2] {
        [self.origin[0] + self.size[0] / 2.0, self.origin[1] + self.size[1] / 2.0]
    }

    /// Whether the transform is one the reference app would accept.
    pub fn is_valid(&self) -> bool {
        self.origin.iter().chain(self.size.iter()).chain([&self.rotation]).all(|v| v.is_finite())
            && self.size[0] >= 1.0
            && self.size[0] <= 300_000.0
            && self.size[1] >= 1.0
            && self.size[1] <= 300_000.0
            && self.origin[0].abs() <= 1_000_000.0
            && self.origin[1].abs() <= 1_000_000.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GuideAxis {
    Horizontal,
    Vertical,
}

/// A user-placed alignment line. `position` is Y for a horizontal guide, X for a vertical one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Guide {
    #[serde(with = "uuid_upper")]
    pub id: Uuid,
    pub axis: GuideAxis,
    pub position: f64,
}

/// One entry in `layers`, bottom to top.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayerRecord {
    #[serde(with = "uuid_upper")]
    pub id: Uuid,
    pub name: String,
    #[serde(default = "default_true", rename = "isVisible")]
    pub is_visible: bool,
    pub transform: Transform,
    #[serde(default, rename = "imageFile", skip_serializing_if = "Option::is_none")]
    pub image_file: Option<String>,
    #[serde(default, rename = "parentID", with = "uuid_upper_opt", skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Uuid>,
    #[serde(default, rename = "isGroup", skip_serializing_if = "Option::is_none")]
    pub is_group: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default, rename = "blendMode", skip_serializing_if = "Option::is_none")]
    pub blend_mode: Option<BlendMode>,
    #[serde(default, rename = "maskFile", skip_serializing_if = "Option::is_none")]
    pub mask_file: Option<String>,
    #[serde(default, rename = "maskEnabled", skip_serializing_if = "Option::is_none")]
    pub mask_enabled: Option<bool>,
    #[serde(
        default,
        rename = "maskSourceID",
        with = "uuid_upper_opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub mask_source_id: Option<Uuid>,
    /// An adjustment layer's settings. Kept verbatim: the schema is large and this build does not
    /// render adjustments yet, but a round-trip must not lose them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adjustment: Option<serde_json::Value>,
    #[serde(default, rename = "maskPlacement", skip_serializing_if = "Option::is_none")]
    pub mask_placement: Option<Transform>,
    #[serde(default, rename = "maskLinked", skip_serializing_if = "Option::is_none")]
    pub mask_linked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effects: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<serde_json::Value>,
}

impl LayerRecord {
    pub fn is_folder(&self) -> bool {
        self.is_group == Some(true)
    }

    pub fn opacity(&self) -> f64 {
        self.opacity.unwrap_or(1.0)
    }

    pub fn blend(&self) -> BlendMode {
        self.blend_mode.unwrap_or_default()
    }

    /// Whether the layer's own pixels take part in compositing (folders and adjustment layers have none).
    pub fn has_pixels(&self) -> bool {
        self.image_file.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(default = "default_format")]
    pub format: String,
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default = "default_color_space", rename = "colorSpace")]
    pub color_space: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<f64>,
    #[serde(with = "uuid_upper", rename = "documentID")]
    pub document_id: Uuid,
    pub width: u32,
    pub height: u32,
    #[serde(
        default,
        rename = "activeLayerID",
        with = "uuid_upper_opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub active_layer_id: Option<Uuid>,
    pub layers: Vec<LayerRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guides: Option<Vec<Guide>>,
}

fn default_format() -> String {
    FORMAT_ID.to_string()
}
fn default_version() -> u32 {
    CURRENT_VERSION
}
fn default_color_space() -> String {
    COLOR_SPACE.to_string()
}

impl Manifest {
    /// A new, empty document.
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            format: FORMAT_ID.to_string(),
            version: CURRENT_VERSION,
            color_space: COLOR_SPACE.to_string(),
            resolution: Some(72.0),
            document_id: Uuid::new_v4(),
            width,
            height,
            active_layer_id: None,
            layers: Vec::new(),
            guides: None,
        }
    }

    /// The resolution to report when the manifest does not carry one. Version 1 projects predate it.
    pub fn resolution_or_default(&self) -> f64 {
        self.resolution.unwrap_or(72.0)
    }

    /// Layer records keyed by id, for walking parent links.
    pub fn by_id(&self) -> std::collections::HashMap<Uuid, &LayerRecord> {
        self.layers.iter().map(|layer| (layer.id, layer)).collect()
    }
}

/// The two fields the loader reads before anything else, so a foreign file is rejected cheaply.
#[derive(Debug, Clone, Deserialize)]
pub struct Header {
    pub format: String,
    pub version: u32,
}
