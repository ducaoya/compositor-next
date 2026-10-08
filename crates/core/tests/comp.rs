//! The `.comp` contract: what loads, what is refused, and what survives a round-trip.

use compositor_core::{
    error::{AssetKind, PackageAssets, ProjectError},
    limits::Limits,
    manifest::{BlendMode, Guide, GuideAxis, LayerRecord, Manifest, Sampling, Transform},
    package, validate, FORMAT_ID,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

// MARK: - Fixtures

/// A 1×1 or n×n RGBA PNG, the shape layer pixels take.
fn rgba_png(width: u32, height: u32) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        let mut data = vec![0u8; (width * height * 4) as usize];
        for (index, pixel) in data.chunks_mut(4).enumerate() {
            pixel[0] = (index % 251) as u8;
            pixel[1] = ((index * 7) % 251) as u8;
            pixel[2] = ((index * 13) % 251) as u8;
            pixel[3] = 255;
        }
        writer.write_image_data(&data).unwrap();
    }
    out
}

/// An 8-bit grayscale PNG, the shape a mask takes.
fn gray_png(width: u32, height: u32) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&vec![128u8; (width * height) as usize]).unwrap();
    }
    out
}

fn limits() -> Limits {
    // Pin the budget so the tests do not depend on the machine's memory.
    Limits { document_pixel_budget: 200_000_000, ..Limits::default() }
}

fn layer(id: Uuid, name: &str, transform: Transform) -> LayerRecord {
    LayerRecord {
        id,
        name: name.to_string(),
        is_visible: true,
        transform,
        image_file: Some(format!("{}.png", id.hyphenated().to_string().to_uppercase())),
        parent_id: None,
        is_group: None,
        opacity: None,
        blend_mode: None,
        mask_file: None,
        mask_enabled: None,
        mask_source_id: None,
        adjustment: None,
        mask_placement: None,
        mask_linked: None,
        shape: None,
        effects: None,
        text: None,
    }
}

fn empty_manifest(width: u32, height: u32) -> Manifest {
    Manifest::new(width, height)
}

// MARK: - The documented example

/// The manifest printed in `docs/writing-comp-files.md`, verbatim. If this stops parsing, the
/// format has drifted.
const DOCUMENTED_EXAMPLE: &str = r#"{
  "format": "com.compositor.project",
  "version": 11,
  "colorSpace": "sRGB",
  "documentID": "0C5E7A91-3B2D-4F6A-8E1C-9D0B7A6F5E4D",
  "width": 1920,
  "height": 1080,
  "resolution": 72,
  "activeLayerID": "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F",
  "layers": [
    {
      "id": "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F",
      "name": "Background",
      "imageFile": "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F.png",
      "isVisible": true,
      "isGroup": false,
      "opacity": 1,
      "blendMode": "Normal",
      "transform": {
        "origin": [0, 0],
        "size": [1920, 1080],
        "rotation": 0,
        "flipX": false,
        "flipY": false,
        "sampling": "High quality"
      }
    }
  ]
}"#;

#[test]
fn the_documented_example_parses() {
    let manifest: Manifest = serde_json::from_str(DOCUMENTED_EXAMPLE).unwrap();
    assert_eq!(manifest.format, FORMAT_ID);
    assert_eq!(manifest.version, 11);
    assert_eq!(manifest.resolution, Some(72.0));
    assert_eq!(manifest.width, 1920);
    assert_eq!(manifest.layers.len(), 1);

    let layer = &manifest.layers[0];
    assert_eq!(layer.name, "Background");
    assert_eq!(layer.transform.origin, [0.0, 0.0]);
    assert_eq!(layer.transform.size, [1920.0, 1080.0]);
    assert_eq!(layer.transform.sampling, Sampling::High);
    assert_eq!(layer.transform.rotation, 0.0);
    assert_eq!(layer.blend(), BlendMode::Normal);
    assert_eq!(layer.opacity(), 1.0);
    assert_eq!(layer.is_group, Some(false));

    validate::validate(&manifest, &limits()).unwrap();
}

/// Points encode as arrays, not `{x, y}` objects. Getting this wrong makes every project from the
/// reference app unreadable.
#[test]
fn points_and_sizes_encode_as_arrays() {
    let transform = Transform::covering(40, 20);
    let value = serde_json::to_value(transform).unwrap();
    assert_eq!(value["origin"], json!([0.0, 0.0]));
    assert_eq!(value["size"], json!([40.0, 20.0]));
    assert_eq!(value["sampling"], json!("High quality"));
}

/// Uppercase on the way out, either case on the way in.
#[test]
fn uuids_are_written_uppercase_and_read_loosely() {
    let id: Uuid = "6f1d3c2a-0b7e-4e8a-9c4d-2a1b3c4d5e6f".parse().unwrap();
    let mut manifest = empty_manifest(16, 16);
    manifest.layers.push(layer(id, "Lower", Transform::covering(16, 16)));

    let value = serde_json::to_value(&manifest).unwrap();
    assert_eq!(value["documentID"], json!(manifest.document_id.hyphenated().to_string().to_uppercase()));
    assert_eq!(
        value["layers"][0]["id"],
        json!("6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F")
    );

    // Lowercase only the ids, not the rest of the text: the reference app's own files are
    // uppercase, but anything hand-written may not be.
    let lowercase = DOCUMENTED_EXAMPLE
        .replace("6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F", "6f1d3c2a-0b7e-4e8a-9c4d-2a1b3c4d5e6f")
        .replace("0C5E7A91-3B2D-4F6A-8E1C-9D0B7A6F5E4D", "0c5e7a91-3b2d-4f6a-8e1c-9d0b7a6f5e4d");
    let parsed: Manifest = serde_json::from_str(&lowercase).unwrap();
    assert_eq!(parsed.layers[0].id, id);
    assert_eq!(parsed.layers[0].image_file.as_deref(), Some("6f1d3c2a-0b7e-4e8a-9c4d-2a1b3c4d5e6f.png"));
}

// MARK: - Round-trip

fn rich_project() -> (Manifest, PackageAssets) {
    let base = Uuid::new_v4();
    let clipped = Uuid::new_v4();
    let folder = Uuid::new_v4();
    let inside = Uuid::new_v4();
    let adjustment = Uuid::new_v4();

    let mut manifest = Manifest::new(512, 512);
    manifest.guides = Some(vec![
        Guide { id: Uuid::new_v4(), axis: GuideAxis::Vertical, position: 128.5 },
        Guide { id: Uuid::new_v4(), axis: GuideAxis::Horizontal, position: 256.0 },
    ]);

    let mut base_layer = layer(base, "Base", Transform::covering(512, 512));
    base_layer.opacity = Some(0.75);
    base_layer.blend_mode = Some(BlendMode::Multiply);
    base_layer.mask_file = Some(AssetKind::Mask.file_name(base));
    base_layer.mask_enabled = Some(true);

    let mut clipped_layer = layer(clipped, "Clipped", Transform::covering(512, 512));
    clipped_layer.mask_source_id = Some(base);
    clipped_layer.blend_mode = Some(BlendMode::Overlay);

    // A folder with its own opacity: only legal from version 8.
    let mut folder_layer = layer(folder, "Folder", Transform::covering(512, 512));
    folder_layer.is_group = Some(true);
    folder_layer.image_file = None;
    folder_layer.opacity = Some(0.5);
    folder_layer.mask_file = Some(AssetKind::Mask.file_name(folder));
    folder_layer.mask_enabled = Some(true);

    let mut inner = layer(inside, "Inside", Transform::covering(512, 512));
    inner.parent_id = Some(folder);

    // An adjustment layer, kept as an opaque subtree because this build does not render them.
    let mut adjustment_layer = layer(adjustment, "Warm Grade", Transform::covering(512, 512));
    adjustment_layer.image_file = None;
    adjustment_layer.adjustment = Some(json!({
        "kind": "Curves",
        "hue": 0, "saturation": 0, "lightness": 0, "colorize": false,
        "curves": { "channel": "RGB", "channels": [
            [ { "x": 0, "y": 0 }, { "x": 120, "y": 147 }, { "x": 255, "y": 255 } ],
            [ { "x": 0, "y": 0 }, { "x": 255, "y": 255 } ],
            [ { "x": 0, "y": 0 }, { "x": 255, "y": 255 } ],
            [ { "x": 0, "y": 0 }, { "x": 255, "y": 255 } ] ] }
    }));

    manifest.layers = vec![base_layer, clipped_layer, folder_layer, inner, adjustment_layer];
    manifest.active_layer_id = Some(folder);

    let mut assets = PackageAssets::new();
    assets.insert(base, AssetKind::Image, rgba_png(64, 64));
    assets.insert(base, AssetKind::Mask, gray_png(64, 64));
    assets.insert(clipped, AssetKind::Image, rgba_png(32, 48));
    assets.insert(folder, AssetKind::Mask, gray_png(8, 8));
    assets.insert(inside, AssetKind::Image, rgba_png(4, 4));
    (manifest, assets)
}

#[test]
fn a_rich_project_round_trips() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("Rich.comp");
    let (manifest, assets) = rich_project();

    package::save(&root, &manifest, &assets, &limits()).unwrap();
    let loaded = package::load(&root, &limits()).unwrap();

    assert_eq!(loaded.manifest, manifest);
    assert_eq!(loaded.images.len(), 3);
    assert_eq!(loaded.masks.len(), 2);

    // Asset paths resolve, and their pixel sizes are reported without decoding.
    let base = manifest.layers[0].id;
    assert_eq!(loaded.images[&base].width, 64);
    assert_eq!(loaded.images[&base].height, 64);
    assert!(loaded.images[&base].path.to_string_lossy().ends_with(".png"));
    assert_eq!(loaded.masks[&base].width, 64);
    assert!(loaded.masks[&base].path.to_string_lossy().ends_with(".mask.png"));
}

/// Subtrees this build does not model must come back unchanged.
#[test]
fn unmodelled_subtrees_survive_a_round_trip() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("Opaque.comp");
    let (mut manifest, assets) = rich_project();

    let effects = json!({
        "stroke": { "size": 6, "red": 1, "green": 0.9, "blue": 0, "opacity": 1, "inside": false }
    });
    manifest.layers[0].effects = Some(effects.clone());
    manifest.layers[0].shape = Some(json!({ "kind": "Rectangle", "cornerRadius": 12 }));
    manifest.layers[3].text = Some(json!({
        "content": "Hello", "fontName": "Helvetica", "fontSize": 48,
        "red": 0, "green": 0, "blue": 0, "alignment": "left", "tracking": 0, "lineSpacing": 1
    }));

    package::save(&root, &manifest, &assets, &limits()).unwrap();
    let loaded = package::load(&root, &limits()).unwrap();

    assert_eq!(loaded.manifest.layers[0].effects.as_ref(), Some(&effects));
    assert!(loaded.manifest.layers[0].shape.is_some());
    assert_eq!(
        loaded.manifest.layers[3].text.as_ref().unwrap()["content"],
        json!("Hello")
    );
}

/// The reference encoder writes sorted keys with two-space indentation. Matching it keeps diffs
/// between the two apps small, and keeps a project readable to anyone opening it by hand.
#[test]
fn the_manifest_is_written_pretty_and_sorted() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("Sorted.comp");
    let (manifest, assets) = rich_project();
    package::save(&root, &manifest, &assets, &limits()).unwrap();

    let text = std::fs::read_to_string(root.join("manifest.json")).unwrap();
    assert!(text.contains("\n  \"activeLayerID\""), "expected two-space indent:\n{text}");
    let active = text.find("\"activeLayerID\"").unwrap();
    let color_space = text.find("\"colorSpace\"").unwrap();
    let document = text.find("\"documentID\"").unwrap();
    assert!(active < color_space && color_space < document, "expected sorted keys:\n{text}");
    assert_eq!(text.trim(), serde_json::to_string_pretty(&serde_json::from_str::<Value>(&text).unwrap()).unwrap());
}

// MARK: - Refusals

fn refuse(manifest: &Manifest, expected: fn(&ProjectError) -> bool) {
    match validate::validate(manifest, &limits()) {
        Ok(()) => panic!("expected a refusal"),
        Err(error) => assert!(expected(&error), "unexpected error: {error}"),
    }
}

#[test]
fn a_foreign_format_is_refused() {
    let mut manifest = empty_manifest(64, 64);
    manifest.format = "com.something.else".into();
    refuse(&manifest, |e| matches!(e, ProjectError::Invalid));
}

#[test]
fn a_newer_version_is_refused_with_its_number() {
    let mut manifest = empty_manifest(64, 64);
    manifest.version = 12;
    refuse(&manifest, |e| matches!(e, ProjectError::Version(12)));
}

#[test]
fn a_canvas_larger_than_the_side_limit_is_refused() {
    let manifest = empty_manifest(30_001, 64);
    refuse(&manifest, |e| matches!(e, ProjectError::TooLarge(_)));
}

#[test]
fn a_mask_that_is_not_named_after_its_layer_is_refused() {
    let mut manifest = empty_manifest(64, 64);
    let id = Uuid::new_v4();
    let mut record = layer(id, "Layer", Transform::covering(64, 64));
    record.mask_file = Some("SOMETHING-ELSE.mask.png".into());
    manifest.layers.push(record);
    refuse(&manifest, |e| matches!(e, ProjectError::Rule { .. }));
}

#[test]
fn a_folder_opacity_needs_version_8() {
    let mut manifest = empty_manifest(64, 64);
    manifest.version = 7;
    let id = Uuid::new_v4();
    let mut record = layer(id, "Folder", Transform::covering(64, 64));
    record.is_group = Some(true);
    record.image_file = None;
    record.opacity = Some(0.5);
    manifest.layers.push(record);
    refuse(&manifest, |e| matches!(e, ProjectError::Rule { .. }));
}

#[test]
fn a_parent_cycle_is_refused() {
    let mut manifest = empty_manifest(64, 64);
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();

    let mut a = layer(first, "A", Transform::covering(64, 64));
    a.is_group = Some(true);
    a.image_file = None;
    a.parent_id = Some(second);

    let mut b = layer(second, "B", Transform::covering(64, 64));
    b.is_group = Some(true);
    b.image_file = None;
    b.parent_id = Some(first);

    manifest.layers = vec![a, b];
    refuse(&manifest, |e| matches!(e, ProjectError::Rule { .. }));
}

#[test]
fn a_clipping_cycle_is_refused() {
    let mut manifest = empty_manifest(64, 64);
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();

    let mut a = layer(first, "A", Transform::covering(64, 64));
    a.mask_source_id = Some(second);
    let mut b = layer(second, "B", Transform::covering(64, 64));
    b.mask_source_id = Some(first);

    manifest.layers = vec![a, b];
    refuse(&manifest, |e| matches!(e, ProjectError::Rule { .. }));
}

#[test]
fn a_group_may_not_carry_pixels() {
    let mut manifest = empty_manifest(64, 64);
    let id = Uuid::new_v4();
    let mut record = layer(id, "Folder", Transform::covering(64, 64));
    record.is_group = Some(true);
    manifest.layers.push(record);
    refuse(&manifest, |e| matches!(e, ProjectError::Rule { .. }));
}

#[test]
fn a_duplicate_layer_id_is_refused() {
    let mut manifest = empty_manifest(64, 64);
    let id = Uuid::new_v4();
    manifest.layers = vec![layer(id, "One", Transform::covering(64, 64)), layer(id, "Two", Transform::covering(64, 64))];
    refuse(&manifest, |e| matches!(e, ProjectError::Rule { .. }));
}

#[test]
fn a_missing_active_layer_is_refused() {
    let mut manifest = empty_manifest(64, 64);
    manifest.active_layer_id = Some(Uuid::new_v4());
    refuse(&manifest, |e| matches!(e, ProjectError::Invalid));
}

// MARK: - Package refusal

#[test]
fn a_missing_image_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("Missing.comp");
    let (manifest, assets) = rich_project();
    package::save(&root, &manifest, &assets, &limits()).unwrap();
    // Remove the file behind Compositor's back, the way a half-synced folder or a crashed agent
    // leaves a project.
    std::fs::remove_file(root.join("images").join(&manifest.layers[0].image_file.clone().unwrap())).unwrap();
    let error = package::load(&root, &limits()).unwrap_err();
    assert!(matches!(error, ProjectError::MissingImage), "got {error}");
}

#[test]
fn a_mask_that_is_not_grayscale_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("ColorMask.comp");
    let (manifest, assets) = rich_project();
    let base = manifest.layers[0].id;
    package::save(&root, &manifest, &assets, &limits()).unwrap();
    // Replace the mask on disk with RGBA pixels.
    std::fs::write(root.join("images").join(AssetKind::Mask.file_name(base)), rgba_png(64, 64)).unwrap();

    let error = package::load(&root, &limits()).unwrap_err();
    assert!(matches!(error, ProjectError::Invalid), "got {error}");
}

#[test]
fn a_project_over_the_pixel_budget_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("Big.comp");
    let mut manifest = empty_manifest(512, 512);
    let id = Uuid::new_v4();
    manifest.layers.push(layer(id, "Huge", Transform::covering(512, 512)));

    let mut assets = PackageAssets::new();
    // 16 × 16 = 256 pixels, against a budget of 100.
    assets.insert(id, AssetKind::Image, rgba_png(16, 16));

    let tight = Limits { document_pixel_budget: 100, ..limits() };
    let error = package::save(&root, &manifest, &assets, &tight).unwrap_err();
    assert!(matches!(error, ProjectError::TooLarge(_)), "got {error}");
}

// MARK: - Housekeeping

#[test]
fn saving_leaves_nothing_beside_the_project() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("Clean.comp");
    let (manifest, assets) = rich_project();

    // Twice, so the replace path runs and not just the create path.
    package::save(&root, &manifest, &assets, &limits()).unwrap();
    package::save(&root, &manifest, &assets, &limits()).unwrap();

    let entries: Vec<String> = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, vec!["Clean.comp".to_string()], "staging or backup folders were left behind: {entries:?}");
}

#[test]
fn creating_an_empty_project_works() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("New.comp");
    let project = package::create(&root, 800, 600, &limits()).unwrap();
    assert_eq!(project.manifest.width, 800);
    assert!(project.manifest.layers.is_empty());
    assert!(root.join("images").is_dir());
}

#[test]
fn a_second_save_replaces_the_first() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("Replace.comp");
    let (manifest, assets) = rich_project();
    package::save(&root, &manifest, &assets, &limits()).unwrap();

    let mut smaller = manifest.clone();
    smaller.layers.truncate(1);
    smaller.active_layer_id = None;
    let mut kept = PackageAssets::new();
    let base = smaller.layers[0].id;
    kept.insert(base, AssetKind::Image, rgba_png(64, 64));
    kept.insert(base, AssetKind::Mask, gray_png(64, 64));
    package::save(&root, &smaller, &kept, &limits()).unwrap();

    let loaded = package::load(&root, &limits()).unwrap();
    assert_eq!(loaded.manifest.layers.len(), 1);
    assert_eq!(loaded.images.len(), 1);
    // The dropped layers' images are gone with the old package.
    let images: Vec<String> = std::fs::read_dir(root.join("images"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(images.len(), 2, "{images:?}");
}

/// Blend-mode strings are the contract with agents and the reference app. A typo here silently
/// changes how a project renders.
#[test]
fn every_blend_mode_uses_its_exact_spelling() {
    let expected: BTreeMap<&str, BlendMode> = BTreeMap::from([
        ("Normal", BlendMode::Normal),
        ("Darken", BlendMode::Darken),
        ("Multiply", BlendMode::Multiply),
        ("Color Burn", BlendMode::ColorBurn),
        ("Linear Burn", BlendMode::LinearBurn),
        ("Lighten", BlendMode::Lighten),
        ("Screen", BlendMode::Screen),
        ("Color Dodge", BlendMode::ColorDodge),
        ("Linear Dodge (Add)", BlendMode::LinearDodge),
        ("Overlay", BlendMode::Overlay),
        ("Soft Light", BlendMode::SoftLight),
        ("Hard Light", BlendMode::HardLight),
        ("Vivid Light", BlendMode::VividLight),
        ("Linear Light", BlendMode::LinearLight),
        ("Pin Light", BlendMode::PinLight),
        ("Hard Mix", BlendMode::HardMix),
        ("Difference", BlendMode::Difference),
        ("Exclusion", BlendMode::Exclusion),
        ("Subtract", BlendMode::Subtract),
        ("Divide", BlendMode::Divide),
        ("Hue", BlendMode::Hue),
        ("Saturation", BlendMode::Saturation),
        ("Color", BlendMode::Color),
        ("Luminosity", BlendMode::Luminosity),
    ]);
    assert_eq!(expected.len(), BlendMode::ALL.len());
    for (text, mode) in expected {
        assert_eq!(serde_json::to_value(mode).unwrap(), json!(text));
        assert_eq!(serde_json::from_value::<BlendMode>(json!(text)).unwrap(), mode);
        assert_eq!(mode.label(), text);
    }
}
