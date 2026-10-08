//! Keeps the canvas shader honest without a GPU.
//!
//! WGSL has no compiler in CI, and a typo in it only shows up as a black canvas at runtime. This
//! crate parses and validates the real file with `naga` — the same front end `wgpu` uses — and
//! checks that its blend-mode cases still line up with the format's list.
//!
//! The shader is compiled by the web build from `web/src/render/compositor.wgsl`; this crate reads
//! the same file, so there is one copy of it.

/// The shader the web renderer compiles, read from the repository.
pub const COMPOSITOR_WGSL: &str = include_str!("../../../web/src/render/compositor.wgsl");

/// The blend modes in the order the shader's `switch` expects, matching `BLEND_MODES` in
/// `web/src/model/types.ts` and `BlendMode::ALL` in `compositor-core`.
pub const BLEND_MODES: [&str; 24] = [
    "Normal",
    "Darken",
    "Multiply",
    "Color Burn",
    "Linear Burn",
    "Lighten",
    "Screen",
    "Color Dodge",
    "Linear Dodge (Add)",
    "Overlay",
    "Soft Light",
    "Hard Light",
    "Vivid Light",
    "Linear Light",
    "Pin Light",
    "Hard Mix",
    "Difference",
    "Exclusion",
    "Subtract",
    "Divide",
    "Hue",
    "Saturation",
    "Color",
    "Luminosity",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn parse() -> naga::Module {
        match naga::front::wgsl::parse_str(COMPOSITOR_WGSL) {
            Ok(module) => module,
            Err(error) => panic!("the shader does not parse:\n{}", error.emit_to_string(COMPOSITOR_WGSL)),
        }
    }

    #[test]
    fn the_compositor_shader_parses_and_validates() {
        let module = parse();
        let mut validator = naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        );
        if let Err(error) = validator.validate(&module) {
            panic!("the shader does not validate:\n{error:?}");
        }
    }

    #[test]
    fn the_shader_exposes_both_passes() {
        let module = parse();
        let names: Vec<&str> = module.entry_points.iter().map(|entry| entry.name.as_str()).collect();
        for expected in ["vs_fullscreen", "fs_composite", "fs_display"] {
            assert!(names.contains(&expected), "{expected} is missing from {names:?}");
        }
    }

    /// The mode numbers are positions in this list. If either drifts, a project renders with the
    /// wrong blend mode — silently.
    #[test]
    fn every_blend_mode_has_its_case_in_order() {
        for (index, name) in BLEND_MODES.iter().enumerate() {
            assert!(
                COMPOSITOR_WGSL.contains(&format!("case {index}u:")),
                "the shader has no case for {index} ({name})"
            );
            assert!(
                COMPOSITOR_WGSL.contains(&format!("// {index}. {name}")),
                "the shader's case {index} is not labelled {name}"
            );
        }
        assert!(
            !COMPOSITOR_WGSL.contains("case 24u:"),
            "the shader has a case past the end of the mode list"
        );
    }

    #[test]
    fn the_shader_blends_in_srgb_not_linear_light() {
        // Spot-check the two formulas that would be written differently in linear light.
        assert!(COMPOSITOR_WGSL.contains("case 2u: { return cb * cs; }"), "Multiply is not cb * cs");
        assert!(COMPOSITOR_WGSL.contains("cb + cs - cb * cs"), "Screen is not cb + cs - cb * cs");
    }
}
