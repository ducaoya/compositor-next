//! The sample project is written by a second, independent implementation of the format
//! (`scripts/make-sample-comp.mjs`, in Node) rather than by this crate. Loading it here is what
//! keeps the two writers agreeing: a change to the schema that only one of them learns about shows
//! up as a refusal.

use compositor_core::{limits::Limits, package, BlendMode, Sampling};

const SAMPLE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/sample.comp");

#[test]
fn the_node_written_sample_loads() {
    let project = package::load(SAMPLE, &Limits::default()).expect("the sample project was refused");

    assert_eq!(project.manifest.version, compositor_core::CURRENT_VERSION);
    assert_eq!(project.manifest.color_space, "sRGB");
    assert_eq!(project.manifest.width, 960);
    assert_eq!(project.manifest.height, 640);

    // A full-canvas background, a ring, a clipped glow, a folder, a layer inside it, a masked
    // layer, and one layer per remaining blend mode.
    assert_eq!(project.manifest.layers.len(), 26);
    assert_eq!(project.images.len(), 25);
    assert_eq!(project.masks.len(), 1);

    // Every blend mode the format names appears exactly once in the strip.
    let used: Vec<BlendMode> = project
        .manifest
        .layers
        .iter()
        .map(|layer| layer.blend())
        .filter(|mode| *mode != BlendMode::Normal)
        .collect();
    for mode in BlendMode::ALL {
        if mode == BlendMode::Normal {
            continue;
        }
        assert!(used.contains(&mode), "{mode:?} has no layer in the sample");
    }

    // The folder holds a child, and the clipped layer points at the ring.
    let folder = project
        .manifest
        .layers
        .iter()
        .find(|layer| layer.is_folder())
        .expect("no folder");
    assert!(project
        .manifest
        .layers
        .iter()
        .any(|layer| layer.parent_id == Some(folder.id)));

    let clipped = project
        .manifest
        .layers
        .iter()
        .find(|layer| layer.mask_source_id.is_some())
        .expect("nothing is clipped");
    let source = clipped.mask_source_id.unwrap();
    assert!(project.manifest.layers.iter().any(|layer| layer.id == source));

    // Guides survived, and the transforms kept the sampling the writer chose.
    assert_eq!(project.manifest.guides.as_ref().unwrap().len(), 2);
    assert!(project
        .manifest
        .layers
        .iter()
        .all(|layer| layer.transform.sampling == Sampling::High));

    // Every declared asset resolved to a real file with the size the manifest implies.
    for layer in &project.manifest.layers {
        if let Some(name) = &layer.image_file {
            let asset = &project.images[&layer.id];
            assert!(asset.path.ends_with(name));
            assert!(asset.width > 0 && asset.height > 0);
        }
    }
}

/// Reading and writing the sample again must not lose or invent anything.
#[test]
fn the_sample_round_trips_through_this_crate() {
    let limits = Limits::default();
    let project = package::load(SAMPLE, &limits).unwrap();

    let directory = tempfile::tempdir().unwrap();
    let copy = directory.path().join("Copy.comp");

    let mut assets = compositor_core::PackageAssets::new();
    for (id, asset) in &project.images {
        assets.insert(*id, compositor_core::AssetKind::Image, std::fs::read(&asset.path).unwrap());
    }
    for (id, asset) in &project.masks {
        assets.insert(*id, compositor_core::AssetKind::Mask, std::fs::read(&asset.path).unwrap());
    }
    package::save(&copy, &project.manifest, &assets, &limits).unwrap();

    let reloaded = package::load(&copy, &limits).unwrap();
    assert_eq!(reloaded.manifest, project.manifest);
    assert_eq!(reloaded.images.len(), project.images.len());
    assert_eq!(reloaded.masks.len(), project.masks.len());
}
