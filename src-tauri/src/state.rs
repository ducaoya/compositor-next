use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use compositor_core::{limits::Limits, Project};

/// A save in flight: where it stages, and where it lands.
pub struct Entry {
    target: PathBuf,
    staging: PathBuf,
}

impl Entry {
    pub fn target(&self) -> &Path {
        &self.target
    }

    pub fn staging(&self) -> &Path {
        &self.staging
    }
}

/// Save sessions in flight, keyed by the id `begin_save` handed out.
///
/// A session is a staging folder beside the project being written. Keeping the map here rather
/// than on the frontend is deliberate: the webview never chooses a path to write to, only a name
/// inside a folder Rust already made. That is what keeps a compromised frontend from writing
/// wherever it likes.
#[derive(Default)]
pub struct SaveSessions {
    inner: Mutex<HashMap<String, Entry>>,
}

impl SaveSessions {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        // A poisoned lock only means another save panicked; the map itself is still consistent.
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn begin(&self, target: PathBuf, staging: PathBuf) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.lock().insert(id.clone(), Entry { target, staging });
        id
    }

    /// The staging folder for a session, without ending it.
    pub fn staging(&self, id: &str) -> Option<PathBuf> {
        self.lock().get(id).map(|entry| entry.staging.clone())
    }

    /// Ends a session, handing back where it staged and where it lands.
    pub fn take(&self, id: &str) -> Option<Entry> {
        self.lock().remove(id)
    }
}

/// The limits the app runs with, resolved once from the machine's memory.
pub fn limits() -> Limits {
    Limits::default()
}

/// The `.comp` the shell was asked to open, when the app was launched by a double-click.
///
/// Taken rather than read, so that a webview reload cannot open the same project a second time —
/// opening a project twice would give two tabs writing to one package.
#[derive(Default)]
pub struct StartupProject(Mutex<Option<String>>);

impl StartupProject {
    pub fn new(path: Option<String>) -> Self {
        Self(Mutex::new(path))
    }

    pub fn take(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take()
    }
}

/// Reads a project and resolves its assets.
pub fn load(path: &str) -> Result<Project, compositor_core::ProjectError> {
    compositor_core::package::load(path, &limits())
}
