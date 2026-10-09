//! The Tauri command layer: the only place the webview and the Rust core meet.
//!
//! The split follows one rule — **the frame path never crosses this boundary**. Rust opens and
//! saves projects, and the webview decodes each layer's PNG straight off disk into a GPU texture
//! through the asset protocol. Nothing per-frame is ever serialized.
//!
//! Saving goes through three calls so that bytes never travel as JSON:
//!
//! 1. `begin_save` creates a staging folder beside the target and returns a session id.
//! 2. `write_asset` writes one PNG, its bytes as a raw IPC body (the `ArrayBuffer` form of
//!    `invoke`), its name in an `x-name` header.
//! 3. `commit_save` validates the staged package and swaps it in.
//!
//! A failed or abandoned save is `abort_save`, and a crash leaves only a staging folder that the
//! next `begin_save` sweeps away.
//!
//! Opening goes the other way: `open_project` answers with the manifest and each asset's path, and
//! the webview fetches the pixels itself over the asset protocol.

mod commands;
mod recovery;
mod state;
mod thumbnail;
mod watcher;

pub use state::{SaveSessions, StartupProject};
pub use thumbnail::{ThumbnailMode, ThumbnailRequest};
pub use watcher::Watchers;

use tauri::{Emitter, Manager};

/// The `.comp` a command line is asking to open, if it names one.
///
/// A double-click on a project reaches the app as an argument, and Tauri does not read the argument
/// list on its own, so this is where "open this file" arrives. A path is recognised by its
/// extension rather than by position because the argument list also carries the shell's own flags —
/// and because a second launch forwards *its* whole command line, which has the path in it too.
///
/// The Windows verbatim prefix (`\\?\`) is dropped and surrounding quotes are trimmed: both are
/// how the path arrives, and neither belongs in a path the rest of the app uses.
fn comp_path_from_args<'a>(args: impl IntoIterator<Item = &'a str>) -> Option<String> {
    args.into_iter()
        .map(|arg| arg.trim().trim_matches('"'))
        .find_map(|arg| {
            let path = arg.strip_prefix(r"\\?\").unwrap_or(arg);
            if path.len() > 5 && path.to_ascii_lowercase().ends_with(".comp") {
                Some(path.to_owned())
            } else {
                None
            }
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    // Read before the window exists: the shell hands the path to the process, and the webview asks
    // for it once it is up, so that a cold start opens the project a double-click named.
    let startup_project = comp_path_from_args(args.iter().map(String::as_str));
    let thumbnail = ThumbnailRequest::from_args(args.iter().map(String::as_str));
    let drawing_a_thumbnail = thumbnail.is_some();

    let mut builder = tauri::Builder::default();
    if !drawing_a_thumbnail {
        // Registered first, as the plugin asks: a second launch of a `.comp` has to reach the window
        // that is already running rather than start a rival copy holding the same project.
        //
        // Not for a thumbnail run, and that is not a detail: Explorer asks for several at once, and
        // each one forwarded to the running window would exit without drawing anything.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = comp_path_from_args(argv.iter().map(String::as_str)) {
                let _ = app.emit("project:open", path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SaveSessions::default())
        .manage(Watchers::default())
        .manage(StartupProject::new(startup_project))
        .manage(ThumbnailMode::new(thumbnail))
        .setup(move |app| {
            // The window is configured hidden and shown here, which is what makes a thumbnail run
            // invisible: it draws in a window that is never shown, where a window created visible
            // and hidden a moment later would flash on someone's screen every time a file manager
            // looked at a project.
            if let Some(window) = app.get_webview_window("main") {
                if drawing_a_thumbnail {
                    let _ = window.hide();
                } else {
                    // The window's own icon, which a development build needs: a packaged one takes it
                    // from the executable, where `tauri-build` embeds `bundle.icon`'s `.ico`.
                    if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")) {
                        let _ = window.set_icon(icon);
                    }
                    let _ = window.show();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_project,
            commands::create_project,
            commands::begin_save,
            commands::write_asset,
            commands::link_asset,
            commands::commit_save,
            commands::abort_save,
            commands::write_file,
            commands::read_file,
            commands::read_app_limits,
            commands::blend_modes,
            commands::list_language_packs,
            commands::install_language_pack,
            commands::open_language_folder,
            commands::startup_project,
            thumbnail::thumbnail_job,
            thumbnail::thumbnail_done,
            recovery::prepare_recovery,
            recovery::label_recovery,
            recovery::list_recovery,
            recovery::discard_recovery,
            watcher::watch_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::comp_path_from_args;

    #[test]
    fn finds_a_comp_path_anywhere_in_the_argument_list() {
        assert_eq!(
            comp_path_from_args(["Compositor.exe", "--flag", r"C:\Work\Poster.comp"]),
            Some(r"C:\Work\Poster.comp".to_string())
        );
        assert_eq!(comp_path_from_args(["a.comp"]), Some("a.comp".to_string()));
    }

    #[test]
    fn a_path_that_arrives_quoted_or_verbatim_is_still_a_path() {
        // The shell quotes a path with spaces, and a Windows path handed to a process can carry the
        // verbatim prefix. Both belong to the argument, not to the path.
        assert_eq!(
            comp_path_from_args([r#""C:\My Work\A Poster.comp""#]),
            Some(r"C:\My Work\A Poster.comp".to_string())
        );
        assert_eq!(
            comp_path_from_args([r"\\?\C:\Work\Poster.comp"]),
            Some(r"C:\Work\Poster.comp".to_string())
        );
    }

    #[test]
    fn nothing_to_open_answers_none() {
        assert_eq!(comp_path_from_args(["Compositor.exe"]), None);
        // A `.comp` is a folder with a five-character extension; a name too short to hold one is a
        // flag or a typo, not a project.
        assert_eq!(comp_path_from_args(["--comp"]), None);
        assert_eq!(comp_path_from_args([".comp"]), None);
        // The extension decides, whatever its case.
        assert_eq!(comp_path_from_args([r"C:\Work\Poster.COMP"]), Some(r"C:\Work\Poster.COMP".to_string()));
        assert_eq!(comp_path_from_args([r"C:\Work\poster.composite"]), None);
    }
}
