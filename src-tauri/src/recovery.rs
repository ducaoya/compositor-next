//! Autosave snapshots, which is what crash recovery is built on.
//!
//! A snapshot is an ordinary `.comp` package written into the app's data folder, plus a small
//! sidecar that says which project it came from. Written that way rather than as a private format
//! for two reasons: the package machinery already stages and swaps atomically, so a crash during an
//! autosave cannot leave a half-written snapshot where a whole one used to be; and a snapshot can
//! be opened as an ordinary project, so recovery needs no second code path for reading pixels.
//!
//! The lifecycle is short on purpose. A snapshot exists only while a document has changes that are
//! not on disk:
//!
//! - the frontend writes one when a dirty document has gone quiet (see `autosave` in the webview);
//! - a real save, or closing the tab, discards it — that is the whole of "this work is now safe";
//! - therefore whatever is left when the app starts belongs to a document that never got saved,
//!   whether the app crashed or was closed with unsaved changes, and the user is asked about it.
//!
//! Nothing here deletes a snapshot on the way out. Deleting on exit is what makes crash recovery
//! fail in exactly the case it exists for, and a clean exit keeps only the snapshots of work that
//! was genuinely unsaved.
//!
//! Recovery never overwrites a project on its own. A recovered document remembers where it came
//! from and writes back there when the user saves, which keeps the decision with the person holding
//! the file and not with the recovery code.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{commands::CommandError, state};

/// The package a snapshot is, inside its own folder.
const SNAPSHOT_NAME: &str = "snapshot.comp";
/// Staging folders `commit_save` sweeps are hidden and carry this in their name.
const STAGING_MARK: &str = ".staging.";

/// The folder snapshots live in, made if it is not there yet.
fn recovery_dir(app: &AppHandle) -> Result<PathBuf, CommandError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| CommandError::new("error.io", error.to_string()))?
        .join("recovery");
    fs::create_dir_all(&dir).map_err(CommandError::from)?;
    Ok(dir)
}

/// A name that can be a folder: ASCII alphanumerics kept, everything else folded to a dash.
fn slug(text: &str) -> String {
    let mut out = String::new();
    for character in text.chars().take(32) {
        if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
            out.push(character);
        } else {
            out.push('-');
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        out.push_str("project");
    }
    out
}

/// FNV-1a. Not a security boundary: it is what keeps two projects with the same file name — two
/// `Untitled.comp`s, or a `Poster.comp` on two drives — from sharing one snapshot folder.
fn fingerprint(text: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in text.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Where one document's snapshot lives: a readable name, plus a fingerprint of where it came from.
///
/// A document that has never been saved has no path to fingerprint, so it is keyed by its own id
/// instead — the frontend keeps one for the life of the tab, which is what makes repeated autosaves
/// of an untitled document land on the same folder rather than piling up.
fn snapshot_key(origin: &str, document: &str) -> String {
    if origin.is_empty() {
        if document.is_empty() {
            format!("untitled-{:08x}", fingerprint(origin))
        } else {
            format!("untitled-{}", slug(document))
        }
    } else {
        let name = Path::new(origin).file_stem().and_then(|stem| stem.to_str()).unwrap_or("project");
        format!("{}-{:08x}", slug(name), fingerprint(origin))
    }
}

/// What a sidecar records about the snapshot beside it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sidecar {
    /// Where the project came from, empty for a document that was never saved.
    origin: String,
    /// The tab it belonged to, which is what a snapshot of an unsaved document is keyed by.
    document: String,
    /// The name to show, so an unsaved document can be offered as something other than a key.
    name: String,
    /// Unix milliseconds, at the moment the snapshot was labelled.
    saved_at: u64,
    /// The app version that wrote it, for a report about a snapshot from an older build.
    app_version: String,
}

/// A snapshot the frontend can offer, as it is described over IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub origin: String,
    pub document: String,
    pub name: String,
    pub saved_at: u64,
    pub app_version: String,
    /// The `.comp` to open. Absolute, so the frontend can open it as it opens any project.
    pub target: String,
}

/// The sidecar beside a snapshot package. `snapshot.comp` and `snapshot.json` sit together.
fn sidecar_path(target: &Path) -> PathBuf {
    target.with_extension("json")
}

/// Refuses a path that is not a snapshot this module made.
///
/// Every one of these commands takes a path from the webview, and every one of them writes or
/// deletes what it is handed. The check is that the path's folder *is* the recovery folder and that
/// the name is one a snapshot uses, so a compromised frontend cannot point them somewhere else.
fn checked_target(app: &AppHandle, target: &str) -> Result<PathBuf, CommandError> {
    let dir = recovery_dir(app)?;
    let path = PathBuf::from(target);
    // A snapshot is always `<recovery>/<key>/snapshot.comp`: one folder down, under the one name.
    let inside = path.parent().and_then(Path::parent) == Some(dir.as_path());
    if !inside || path.file_name().and_then(|name| name.to_str()) != Some(SNAPSHOT_NAME) {
        return Err(CommandError::new("error.notASnapshot", target));
    }
    Ok(path)
}

/// The folder for one document's snapshot, swept of anything an earlier run abandoned.
fn snapshot_dir(app: &AppHandle, origin: &str, document: &str) -> Result<PathBuf, CommandError> {
    let dir = recovery_dir(app)?;
    // A crash in the middle of an autosave leaves a `.snapshot.comp.staging.*` folder behind, and
    // `staging_directory` only sweeps leftovers for the target it is about to write. Sweeping the
    // whole folder here is what keeps a year of crashes from being a year of folders.
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') && name.contains(STAGING_MARK) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    let folder = dir.join(snapshot_key(origin, document));
    fs::create_dir_all(&folder).map_err(CommandError::from)?;
    Ok(folder)
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_millis() as u64).unwrap_or(0)
}

/// Where the snapshot for this document goes, made ready to write into.
///
/// The frontend passes the answer straight to `begin_save`, so an autosave is the same three calls
/// a save is — same staging, same atomic swap, same refusal to leave a half-written package.
#[tauri::command]
pub fn prepare_recovery(
    app: AppHandle,
    origin: String,
    document: String,
) -> Result<String, CommandError> {
    let folder = snapshot_dir(&app, &origin, &document)?;
    Ok(folder.join(SNAPSHOT_NAME).to_string_lossy().into_owned())
}

/// Records what the package beside it is, once the package has been committed.
///
/// Written after the swap and never before: a sidecar that named a package which failed to write
/// would offer a snapshot that is not there.
#[tauri::command]
pub fn label_recovery(
    app: AppHandle,
    target: String,
    origin: String,
    document: String,
    name: String,
) -> Result<(), CommandError> {
    let target = checked_target(&app, &target)?;
    let sidecar = Sidecar {
        origin,
        document,
        name,
        saved_at: now_millis(),
        app_version: app.package_info().version.to_string(),
    };
    let text = serde_json::to_vec(&sidecar)
        .map_err(|error| CommandError::new("error.io", error.to_string()))?;
    fs::write(sidecar_path(&target), text).map_err(CommandError::from)
}

/// Every snapshot worth offering, newest first.
///
/// A snapshot whose package no longer loads — half-written by a crash, or written by a build that
/// is no longer here — is left out and its sidecar removed, because offering a document that cannot
/// be opened is worse than offering nothing.
#[tauri::command]
pub fn list_recovery(app: AppHandle) -> Result<Vec<RecoveryEntry>, CommandError> {
    let dir = recovery_dir(&app)?;
    let limits = state::limits();
    let mut entries = Vec::new();
    let Ok(listing) = fs::read_dir(&dir) else { return Ok(entries) };
    for entry in listing.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let target = path.join(SNAPSHOT_NAME);
        let sidecar = sidecar_path(&target);
        let Ok(text) = fs::read(&sidecar) else { continue };
        let Ok(record) = serde_json::from_slice::<Sidecar>(&text) else {
            continue;
        };
        if compositor_core::package::load(&target, &limits).is_err() {
            let _ = fs::remove_dir_all(&path);
            let _ = fs::remove_file(&sidecar);
            continue;
        }
        entries.push(RecoveryEntry {
            origin: record.origin,
            document: record.document,
            name: record.name,
            saved_at: record.saved_at,
            app_version: record.app_version,
            target: target.to_string_lossy().into_owned(),
        });
    }
    entries.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(entries)
}

/// Throws a snapshot away: after the work reached its own file, or when the user says so.
#[tauri::command]
pub fn discard_recovery(app: AppHandle, target: String) -> Result<(), CommandError> {
    let target = checked_target(&app, &target)?;
    let _ = fs::remove_file(sidecar_path(&target));
    if let Some(folder) = target.parent() {
        let _ = fs::remove_dir_all(folder);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{fingerprint, sidecar_path, slug, snapshot_key};
    use std::path::Path;

    #[test]
    fn a_key_is_stable_for_a_path_and_different_for_another() {
        let one = snapshot_key(r"C:\Work\Poster.comp", "tab-1");
        assert_eq!(one, snapshot_key(r"C:\Work\Poster.comp", "tab-2"));
        assert_eq!(one, snapshot_key(r"C:\Work\Poster.comp", "tab-1"));
        assert_ne!(one, snapshot_key(r"D:\Work\Poster.comp", "tab-1"));
        assert_ne!(one, snapshot_key(r"C:\Work\Other.comp", "tab-1"));
        assert!(one.starts_with("Poster-"), "{one} should say which project it is");
    }

    #[test]
    fn an_unsaved_document_is_keyed_by_its_tab() {
        let one = snapshot_key("", "m1abc-xy12");
        assert_ne!(one, snapshot_key("", "m1abc-zz99"));
        assert_eq!(one, snapshot_key("", "m1abc-xy12"));
        // Nothing at all to go on still has to land somewhere stable, or every autosave would make
        // a new folder.
        assert_eq!(snapshot_key("", ""), snapshot_key("", ""));
    }

    #[test]
    fn a_key_is_a_folder_name_and_nothing_else() {
        let key = snapshot_key(r"C:\My Work\A Póster.comp", "tab-1");
        assert!(key.is_ascii(), "{key} should be ASCII");
        assert!(!key.contains(['/', '\\', ':', '.']), "{key} should hold no path characters");
        assert_eq!(slug(""), "project");
        assert_eq!(slug("a///b"), "a---b");
        assert_eq!(slug(&"x".repeat(64)).len(), 32);
    }

    #[test]
    fn a_sidecar_sits_beside_the_package_it_describes() {
        assert_eq!(
            sidecar_path(Path::new(r"C:\data\recovery\Poster-1f2e3d4c\snapshot.comp")),
            Path::new(r"C:\data\recovery\Poster-1f2e3d4c\snapshot.json").to_path_buf()
        );
    }

    #[test]
    fn a_fingerprint_does_not_depend_on_anything_but_its_input() {
        assert_eq!(fingerprint("a"), fingerprint("a"));
        assert_ne!(fingerprint("a"), fingerprint("b"));
    }
}
