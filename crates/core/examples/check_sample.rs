fn main() {
    let limits = compositor_core::Limits::default();
    match compositor_core::package::load("examples/sample.comp", &limits) {
        Ok(project) => println!(
            "ok: {} layers, {} images, {} masks, {}x{}",
            project.manifest.layers.len(),
            project.images.len(),
            project.masks.len(),
            project.manifest.width,
            project.manifest.height
        ),
        Err(error) => {
            eprintln!("refused: {error}");
            std::process::exit(1);
        }
    }
}
