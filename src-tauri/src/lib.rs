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

mod commands;
mod state;

pub use state::SaveSessions;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(SaveSessions::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_project,
            commands::create_project,
            commands::begin_save,
            commands::write_asset,
            commands::link_asset,
            commands::commit_save,
            commands::abort_save,
            commands::write_file,
            commands::read_app_limits,
            commands::blend_modes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
