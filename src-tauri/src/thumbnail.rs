//! Drawing a project's thumbnail, for the shell to show in a file manager.
//!
//! Windows asks for a thumbnail through a COM provider that runs inside Explorer's process and has
//! to hand back a bitmap, which means the provider itself is a small DLL that ships beside the app
//! (`crates/thumbnail`). It does not composite anything: it runs *this* binary with `--thumbnail`,
//! waits, and loads the PNG that comes out.
//!
//! That is the whole design, and the alternative is why. A thumbnail has to be *composited* — 24
//! blend modes, twelve adjustment layers, masks, six layer effects — and the only renderer in this
//! project that does that correctly is the one in the webview. Writing a second one in Rust for the
//! shell would be a third copy of the blend maths (there are already two, TypeScript and WGSL, kept
//! in step by a test that reads the real shader), and a thumbnail that disagrees with the document it
//! came from is worse than no thumbnail at all. This way there is one renderer and no drift.
//!
//! What it costs is time: a webview has to start, which is a second or so rather than the few
//! milliseconds a native decoder would take. Explorer caches what a provider returns, so it is paid
//! once per file rather than once per look — and the window it starts is never shown.
//!
//! A thumbnail run is deliberately *not* a normal launch: the single-instance plugin is not
//! registered for it (several thumbnails can be asked for at once, and each would otherwise be
//! forwarded to the running window and exit without drawing anything), no session is recovered, no
//! autosave runs, and the process exits as soon as the file is written.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, State};

/// What the shell asked for: a project to draw, and where to put the picture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThumbnailRequest {
    pub source: String,
    pub target: String,
    /// The longest side, in pixels. Windows asks for what it will draw at.
    pub size: u32,
}

/// The default when the provider does not say: Explorer's own large-icon size, doubled.
pub const DEFAULT_SIZE: u32 = 256;

impl ThumbnailRequest {
    /// Reads `--thumbnail <source> <target> [size]`, or nothing when this is a normal launch.
    ///
    /// The two paths are taken in order, and a path that is not one is not a path: a size is a
    /// number, and anything else is treated as missing rather than as a third path.
    pub fn from_args<'a>(args: impl IntoIterator<Item = &'a str>) -> Option<Self> {
        let words: Vec<&str> = args
            .into_iter()
            .map(|word| word.trim().trim_matches('"'))
            .collect();
        let at = words.iter().position(|word| *word == "--thumbnail")?;
        let source = words.get(at + 1)?.to_string();
        let target = words.get(at + 2)?.to_string();
        let size = words
            .get(at + 3)
            .and_then(|word| word.parse::<u32>().ok())
            .filter(|size| *size > 0)
            .unwrap_or(DEFAULT_SIZE);
        Some(Self { source, target, size })
    }
}

/// The request, handed to the webview once and then forgotten.
///
/// Taken rather than read for the same reason the startup project is: a reload of the webview must
/// not start drawing the same thumbnail again.
#[derive(Default)]
pub struct ThumbnailMode(Mutex<Option<ThumbnailRequest>>);

impl ThumbnailMode {
    pub fn new(request: Option<ThumbnailRequest>) -> Self {
        Self(Mutex::new(request))
    }

    pub fn is_active(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
    }

    fn take(&self) -> Option<ThumbnailRequest> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }
}

/// The request as the frontend sees it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailJob {
    pub source: String,
    pub target: String,
    pub size: u32,
}

/// What to draw, once. Null for a normal launch.
#[tauri::command]
pub fn thumbnail_job(state: State<'_, ThumbnailMode>) -> Option<ThumbnailJob> {
    state.take().map(|request| ThumbnailJob {
        source: request.source,
        target: request.target,
        size: request.size,
    })
}

/// Ends a thumbnail run, once the picture is on disk.
///
/// Exiting from here rather than from the frontend's own teardown is what keeps a thumbnail from
/// leaving a process behind: the webview has no way to close the window it was started with, and
/// the shell is waiting on the process rather than on the file.
#[tauri::command]
pub fn thumbnail_done(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ThumbnailRequest, DEFAULT_SIZE};

    #[test]
    fn a_thumbnail_run_names_where_to_draw_and_where_to_put_it() {
        let request = ThumbnailRequest::from_args([
            "Compositor.exe",
            "--thumbnail",
            r"C:\Work\Poster.comp",
            r"C:\Temp\Poster.png",
            "512",
        ])
        .expect("a request");
        assert_eq!(request.source, r"C:\Work\Poster.comp");
        assert_eq!(request.target, r"C:\Temp\Poster.png");
        assert_eq!(request.size, 512);
    }

    #[test]
    fn the_size_is_optional_and_a_bad_one_is_not_a_path() {
        let bare = ThumbnailRequest::from_args([
            "Compositor.exe",
            "--thumbnail",
            "a.comp",
            "b.png",
        ])
        .expect("a request");
        assert_eq!(bare.size, DEFAULT_SIZE);

        // "huge" is not a size, so it is treated as unsaid rather than as the target path's name.
        let odd = ThumbnailRequest::from_args(["x", "--thumbnail", "a.comp", "b.png", "huge"])
            .expect("a request");
        assert_eq!(odd.target, "b.png");
        assert_eq!(odd.size, DEFAULT_SIZE);
    }

    #[test]
    fn an_ordinary_launch_is_not_a_thumbnail_run() {
        assert_eq!(ThumbnailRequest::from_args(["Compositor.exe"]), None);
        assert_eq!(
            ThumbnailRequest::from_args(["Compositor.exe", r"C:\Work\Poster.comp"]),
            None
        );
        // Named but with nothing to draw, or nowhere to put it.
        assert_eq!(ThumbnailRequest::from_args(["x", "--thumbnail"]), None);
        assert_eq!(ThumbnailRequest::from_args(["x", "--thumbnail", "a.comp"]), None);
    }

    #[test]
    fn a_quoted_path_is_still_a_path() {
        let request = ThumbnailRequest::from_args([
            "Compositor.exe",
            "--thumbnail",
            r#""C:\My Work\A Poster.comp""#,
            r#""C:\My Work\out.png""#,
        ])
        .expect("a request");
        assert_eq!(request.source, r"C:\My Work\A Poster.comp");
        assert_eq!(request.target, r"C:\My Work\out.png");
    }
}
