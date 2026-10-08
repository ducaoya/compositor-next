//! The rules a manifest must satisfy to load.
//!
//! This mirrors the reference app's validator (`ProjectStore.validate`, plus
//! `LayerHierarchy.validate` and `LiveMaskGraph.validate`) rule for rule, including the version
//! gating: a file declaring an older version may not use a field that version did not have.

use std::collections::{HashMap, HashSet};

use uuid::Uuid;

use crate::{
    error::ProjectError,
    limits::Limits,
    manifest::{GuideAxis, Manifest, COLOR_SPACE, FORMAT_ID},
};

/// Checks `manifest` against `limits`. Returns the first rule it breaks.
pub fn validate(manifest: &Manifest, limits: &Limits) -> Result<(), ProjectError> {
    if manifest.format != FORMAT_ID {
        return Err(ProjectError::Invalid);
    }
    if !(crate::MIN_VERSION..=crate::CURRENT_VERSION).contains(&manifest.version) {
        return Err(ProjectError::Version(manifest.version));
    }
    if manifest.color_space != COLOR_SPACE {
        return Err(ProjectError::Invalid);
    }
    if let Some(resolution) = manifest.resolution {
        if !resolution.is_finite() || !(1.0..=9600.0).contains(&resolution) {
            return Err(ProjectError::Invalid);
        }
    }

    let version = manifest.version;
    if manifest.width == 0
        || manifest.width > limits.max_side
        || manifest.height == 0
        || manifest.height > limits.max_side
    {
        return Err(ProjectError::TooLarge(limits.document_budget_megapixels()));
    }
    if manifest.layers.len() > limits.max_layers {
        return Err(ProjectError::TooLarge(limits.document_budget_megapixels()));
    }

    let mut ids: HashSet<Uuid> = HashSet::new();
    for layer in &manifest.layers {
        if !ids.insert(layer.id) {
            return Err(ProjectError::layer_rule(layer.id, "two layers share one id"));
        }
    }
    let by_id: HashMap<Uuid, &crate::manifest::LayerRecord> =
        manifest.layers.iter().map(|layer| (layer.id, layer)).collect();

    for layer in &manifest.layers {
        let id = layer.id;
        let folder = layer.is_folder();

        // Text layers: per-letter colors arrived in version 10, per-letter faces in version 11.
        if let Some(text) = &layer.text {
            if has_key(text, "colorRuns") && version < 10 {
                return Err(ProjectError::layer_rule(id, "per-letter colors need format version 10"));
            }
            if has_key(text, "fontRuns") && version < 11 {
                return Err(ProjectError::layer_rule(id, "per-letter fonts need format version 11"));
            }
            if layer.image_file.is_none() || folder || layer.adjustment.is_some() {
                return Err(ProjectError::layer_rule(id, "a text layer needs pixels, and is neither a folder nor an adjustment"));
            }
        }

        // Adjustment layers arrived in version 7; the three that sample neighbors in version 9.
        if let Some(adjustment) = &layer.adjustment {
            if version < 7 {
                return Err(ProjectError::layer_rule(id, "adjustment layers need format version 7"));
            }
            if folder || layer.image_file.is_some() {
                return Err(ProjectError::layer_rule(id, "an adjustment layer has no pixels and is not a folder"));
            }
            let kind = adjustment.get("kind").and_then(|v| v.as_str()).unwrap_or_default();
            let needs_nine = matches!(kind, "Gaussian Blur" | "Motion Blur" | "Add Noise");
            if needs_nine && version < 9 {
                return Err(ProjectError::layer_rule(id, "this adjustment needs format version 9"));
            }
        }

        // Layer masks arrived in version 4; folder masks in version 6.
        if let Some(mask_file) = &layer.mask_file {
            let floor = if folder { 6 } else { 4 };
            if version < floor {
                return Err(ProjectError::layer_rule(id, "layer masks need a newer format version"));
            }
            if *mask_file != format!("{}.mask.png", upper(id)) {
                return Err(ProjectError::layer_rule(id, "a mask file must be named after its layer"));
            }
        } else if layer.mask_enabled.is_some() || layer.mask_placement.is_some() {
            return Err(ProjectError::layer_rule(id, "a mask setting needs a mask file"));
        }
        if let Some(placement) = layer.mask_placement {
            if !placement.is_valid() {
                return Err(ProjectError::layer_rule(id, "the mask's placement is out of range"));
            }
        }

        let opacity = layer.opacity();
        let blend = layer.blend();
        if !opacity.is_finite() || !(0.0..=1.0).contains(&opacity) {
            return Err(ProjectError::layer_rule(id, "opacity must be between 0 and 1"));
        }
        // Folders took an opacity of their own in version 8, which multiplies into what is inside
        // them; their blend mode is pass-through, so it stays Normal.
        if folder {
            if blend != crate::manifest::BlendMode::Normal {
                return Err(ProjectError::layer_rule(id, "a folder composites its contents, so its blend mode stays Normal"));
            }
            if opacity != 1.0 && version < 8 {
                return Err(ProjectError::layer_rule(id, "a folder's own opacity needs format version 8"));
            }
        }
        if version < 3 && (opacity != 1.0 || blend != crate::manifest::BlendMode::Normal) {
            return Err(ProjectError::layer_rule(id, "opacity and blend modes need format version 3"));
        }
        if version < 5 && layer.mask_source_id.is_some() {
            return Err(ProjectError::layer_rule(id, "clipping masks need format version 5"));
        }

        if !layer.transform.is_valid() {
            return Err(ProjectError::layer_rule(id, "the layer's transform is out of range"));
        }
        if layer.name.trim().is_empty() {
            return Err(ProjectError::layer_rule(id, "a layer needs a name"));
        }
        if layer.name.len() > limits.max_name_bytes {
            return Err(ProjectError::layer_rule(id, "the layer's name is too long"));
        }
        match &layer.image_file {
            Some(file) if file != &format!("{}.png", upper(id)) => {
                return Err(ProjectError::layer_rule(id, "an image file must be named after its layer"));
            }
            None if folder => {}
            _ => {}
        }
        if folder && layer.image_file.is_some() {
            return Err(ProjectError::layer_rule(id, "a folder holds no pixels of its own"));
        }
    }

    if let Some(active) = manifest.active_layer_id {
        if !ids.contains(&active) {
            return Err(ProjectError::Invalid);
        }
    }

    validate_hierarchy(manifest, &by_id, limits)?;
    validate_clipping(manifest, &by_id, limits)?;
    validate_guides(manifest, limits)?;

    Ok(())
}

/// Parents must be folders, links must not cycle, and nesting stops at `MAX_NESTING`.
fn validate_hierarchy(
    manifest: &Manifest,
    by_id: &HashMap<Uuid, &crate::manifest::LayerRecord>,
    limits: &Limits,
) -> Result<(), ProjectError> {
    for layer in &manifest.layers {
        let mut seen: HashSet<Uuid> = HashSet::from([layer.id]);
        let mut parent = layer.parent_id;
        while let Some(id) = parent {
            if seen.len() > limits.max_nesting || !seen.insert(id) {
                return Err(ProjectError::layer_rule(layer.id, "folders are nested in a cycle or too deeply"));
            }
            let node = by_id.get(&id).ok_or(ProjectError::Invalid)?;
            if !node.is_folder() {
                return Err(ProjectError::layer_rule(layer.id, "a layer's parent is not a folder"));
            }
            parent = node.parent_id;
        }
    }
    Ok(())
}

/// A clipping mask's source must be a plain layer, and the chain must terminate.
fn validate_clipping(
    manifest: &Manifest,
    by_id: &HashMap<Uuid, &crate::manifest::LayerRecord>,
    limits: &Limits,
) -> Result<(), ProjectError> {
    for layer in &manifest.layers {
        let mut path: HashSet<Uuid> = HashSet::new();
        let mut current = Some(layer.id);
        while let Some(id) = current {
            if path.len() >= limits.max_clip_chain || !path.insert(id) {
                return Err(ProjectError::layer_rule(layer.id, "clipping masks form a cycle or a chain that is too long"));
            }
            let record = by_id.get(&id).ok_or(ProjectError::Invalid)?;
            if let Some(source) = record.mask_source_id {
                let target = by_id.get(&source).ok_or(ProjectError::Invalid)?;
                if record.is_folder() || target.is_folder() || target.adjustment.is_some() {
                    return Err(ProjectError::layer_rule(
                        layer.id,
                        "only a plain layer can supply a clipping mask's coverage",
                    ));
                }
            }
            current = record.mask_source_id;
        }
    }
    Ok(())
}

/// Guides arrived in version 8.
fn validate_guides(manifest: &Manifest, limits: &Limits) -> Result<(), ProjectError> {
    let guides = manifest.guides.as_deref().unwrap_or(&[]);
    if manifest.version < 8 {
        if !guides.is_empty() {
            return Err(ProjectError::rule("guides need format version 8"));
        }
        return Ok(());
    }
    if guides.len() > limits.max_guides {
        return Err(ProjectError::TooLarge(limits.document_budget_megapixels()));
    }
    let mut ids = HashSet::new();
    for guide in guides {
        if !ids.insert(guide.id) {
            return Err(ProjectError::rule("two guides share one id"));
        }
        if !guide.position.is_finite() || guide.position.abs() > 1_000_000.0 {
            return Err(ProjectError::rule("a guide is off the canvas"));
        }
        if !matches!(guide.axis, GuideAxis::Horizontal | GuideAxis::Vertical) {
            return Err(ProjectError::rule("a guide's axis is neither horizontal nor vertical"));
        }
    }
    Ok(())
}

/// Charges `width` × `height` against a running pixel total, as the asset loader does.
pub(crate) fn charge_pixels(
    width: u32,
    height: u32,
    used: &mut u64,
    limits: &Limits,
) -> Result<(), ProjectError> {
    if width == 0 || height == 0 || width > limits.max_side || height > limits.max_side {
        return Err(ProjectError::TooLarge(limits.document_budget_megapixels()));
    }
    let pixels = width as u64 * height as u64;
    if used.saturating_add(pixels) > limits.document_pixel_budget {
        return Err(ProjectError::TooLarge(limits.document_budget_megapixels()));
    }
    *used += pixels;
    Ok(())
}

fn has_key(value: &serde_json::Value, key: &str) -> bool {
    value.get(key).is_some_and(|v| !v.is_null())
}

fn upper(id: Uuid) -> String {
    id.hyphenated().to_string().to_uppercase()
}
