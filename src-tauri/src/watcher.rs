//! Watching an open project for changes made by anything else.
//!
//! A `.comp` is a folder of files, and the whole point of that is that other things can write it: an
//! agent building a scene, a sync client, a git checkout, the sample script in this repository. The
//! editor reloads when that happens, so the person watching the canvas sees the change arrive.
//!
//! The watch is recursive over the package, which covers the manifest and the images folder at
//! once. Coalescing is left to the frontend: a save touches a dozen files, and one reload per dozen
//! events is cheaper to write than a debounce thread here, and no slower for it.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

use crate::commands::CommandError;

/// One watcher per open project, kept alive for as long as the project is.
///
/// A `notify` watcher stops watching when it is dropped, so the map is not a cache — it is the
/// lifetime.
#[derive(Default)]
pub struct Watchers(Mutex<HashMap<String, RecommendedWatcher>>);

impl Watchers {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, RecommendedWatcher>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn clear(&self, id: &str) {
        // Dropping the watcher is what stops it.
        self.lock().remove(id);
    }
}

/// Makes a watcher for a folder, calling `on_event` for anything but a read.
///
/// Separated from the command so it can be tested without a window: the command is this plus an
/// emitter, and the part worth testing is this.
pub fn watcher_for(
    directory: &std::path::Path,
    on_event: impl Fn() + Send + 'static,
) -> Result<RecommendedWatcher, notify::Error> {
    let mut watcher = notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
        let Ok(event) = result else { return };
        // Reading a file is not a change to it. Everything else — create, write, rename, remove —
        // is something the editor should look at again.
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        on_event();
    })?;
    watcher.watch(directory, RecursiveMode::Recursive)?;
    Ok(watcher)
}

/// Starts watching a project, or stops when `enabled` is false.
#[tauri::command]
pub fn watch_project(
    app: AppHandle,
    state: State<'_, Watchers>,
    id: String,
    path: String,
    enabled: bool,
) -> Result<(), CommandError> {
    state.clear(&id);
    if !enabled {
        return Ok(());
    }

    let directory = PathBuf::from(&path);
    if !directory.is_dir() {
        return Err(CommandError::new("error.notFound", path));
    }

    let emitter = app.clone();
    let watched = id.clone();
    let watcher = watcher_for(&directory, move || {
        let _ = emitter.emit("project:changed", serde_json::json!({ "id": watched }));
    })
    .map_err(|error| CommandError::new("error.io", error.to_string()))?;

    // Kept, not cached: dropping it stops the watch.
    state.lock().insert(id, watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::{Duration, Instant};

    use super::*;

    /// Writes to a watched folder and waits for an event to arrive.
    ///
    /// Polls rather than sleeping a fixed time: a watcher that reports late is fine, one that never
    /// reports is not, and a fixed sleep cannot tell the two apart.
    #[test]
    fn a_write_inside_the_watched_folder_reports() {
        let directory = tempfile::tempdir().unwrap();
        let seen = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&seen);
        let _watcher = watcher_for(directory.path(), move || {
            counter.fetch_add(1, Ordering::SeqCst);
        })
        .expect("a watcher for a real folder");

        // The watch is armed asynchronously, so the first write can land before it is listening.
        let deadline = Instant::now() + Duration::from_secs(10);
        while seen.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::fs::write(directory.path().join("manifest.json"), b"{}").unwrap();
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(seen.load(Ordering::SeqCst) > 0, "nothing was reported");
    }

    /// A nested write is reported too, which is what makes watching the package enough to cover
    /// its `images` folder.
    #[test]
    fn a_write_in_a_subfolder_reports() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("images")).unwrap();
        let seen = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&seen);
        let _watcher = watcher_for(directory.path(), move || {
            counter.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        while seen.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::fs::write(directory.path().join("images").join("layer.png"), b"x").unwrap();
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(seen.load(Ordering::SeqCst) > 0, "a nested write was not reported");
    }

    /// Dropping the watcher stops it, which is the whole reason the map holds it rather than
    /// caching it.
    #[test]
    fn dropping_the_watcher_stops_reporting() {
        let directory = tempfile::tempdir().unwrap();
        let seen = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&seen);
        let watcher = watcher_for(directory.path(), move || {
            counter.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        while seen.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::fs::write(directory.path().join("manifest.json"), b"{}").unwrap();
            std::thread::sleep(Duration::from_millis(100));
        }
        drop(watcher);

        let before = seen.load(Ordering::SeqCst);
        for _ in 0..5 {
            std::fs::write(directory.path().join("manifest.json"), b"{}").unwrap();
            std::thread::sleep(Duration::from_millis(60));
        }
        assert_eq!(seen.load(Ordering::SeqCst), before, "the watcher was still reporting");
    }
}
