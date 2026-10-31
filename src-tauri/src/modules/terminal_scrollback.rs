//! Saved terminal scrollback, one file per pane under
//! `<app data>/terminal-scrollback/<key>.vt` for the main window and
//! `<app data>/windows/<label>/terminal-scrollback/` for each other window
//! (`windows.rs`), restored into the pane after a restart. A window's retain
//! sweep only ever sees its own files.
//!
//! The webview owns the format (UTF-8 text with SGR styles) and the keys; this
//! side only stores bytes. Every write goes to a private temporary file in the
//! same directory and is renamed over the old one, so a reader sees the old
//! file or the new one, never a torn mix. Files are not flushed to the drive:
//! a power cut can cost the latest save, and the webview treats a damaged file
//! as no history. One gate serializes saves, loads and the retain sweep, so the
//! sweep never removes a file a save is about to publish.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::ipc::{Request, Response};
use tauri::{Manager, State};

use super::{ipc_body, windows};

const DIRECTORY: &str = "terminal-scrollback";
const EXTENSION: &str = ".vt";
const KEY_HEADER: &str = "x-oarlock-scrollback";
/// A larger body is refused; the webview trims history well below this.
const MAX_SCROLLBACK_BYTES: usize = 8 * 1024 * 1024;
/// Far above any real pane count; a longer list is refused, never truncated,
/// because truncating it would delete history that is still referenced.
const MAX_RETAINED_KEYS: usize = 16 * 1024;

#[derive(Default)]
pub struct ScrollbackState {
    gate: Arc<tokio::sync::Mutex<()>>,
}

impl ScrollbackState {
    /// Held while a window's scrollback directory is deleted.
    pub(crate) fn gate(&self) -> Arc<tokio::sync::Mutex<()>> {
        self.gate.clone()
    }
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

pub(crate) fn directory(root: &Path) -> PathBuf {
    root.join(DIRECTORY)
}

fn scrollback_path(root: &Path, key: &str) -> Result<PathBuf, String> {
    if !valid_key(key) {
        return Err("invalid scrollback key".into());
    }
    Ok(directory(root).join(format!("{key}{EXTENSION}")))
}

/// The key a stored file belongs to, or `None` for anything else in the
/// directory (temporary files of an interrupted save, foreign files).
fn key_of(file_name: &str) -> Option<&str> {
    file_name
        .strip_suffix(EXTENSION)
        .filter(|key| valid_key(key))
}

fn create_directory(path: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(std::io::Error::other("Scrollback directory is a symbolic link"));
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn validate_root(root: &Path) -> Result<(), String> {
    match fs::symlink_metadata(root) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err("Window state root is not a plain directory".into()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(unix)]
fn open_directory(path: &Path) -> std::io::Result<cap_std::fs::Dir> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new().read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    Ok(cap_std::fs::Dir::from_std_file(file))
}

#[cfg(not(unix))]
fn open_directory(_: &Path) -> std::io::Result<cap_std::fs::Dir> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "Safe scrollback access is unavailable"))
}

fn remove_if_present(root: &Path, key: &str) -> Result<(), String> {
    let path = scrollback_path(root, key)?;
    let dir = match open_directory(&directory(root)) {
        Ok(dir) => dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    match dir.remove_file(path.file_name().ok_or("missing scrollback name")?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Replaces the pane's file; an empty body deletes it.
fn save(root: &Path, key: &str, bytes: &[u8]) -> Result<(), String> {
    validate_root(root)?;
    let path = scrollback_path(root, key)?;
    if bytes.len() > MAX_SCROLLBACK_BYTES {
        return Err(format!(
            "scrollback exceeds {} MiB",
            MAX_SCROLLBACK_BYTES / (1024 * 1024)
        ));
    }
    if bytes.is_empty() {
        return remove_if_present(root, key);
    }
    std::str::from_utf8(bytes).map_err(|_| "scrollback must be UTF-8 text")?;
    create_directory(root).map_err(|e| e.to_string())?;
    let parent = path.parent().ok_or("missing scrollback directory")?;
    create_directory(parent).map_err(|e| e.to_string())?;
    super::fs::native_store::write_private(&path, bytes, MAX_SCROLLBACK_BYTES as u64, |_| Ok(()))
}

/// The stored bytes, empty when the pane has none. A link or a directory in
/// the file's place reads as no history; it is never followed.
fn load(root: &Path, key: &str) -> Result<Vec<u8>, String> {
    validate_root(root)?;
    let path = scrollback_path(root, key)?;
    let file = match super::fs::open_store_file(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            log::warn!("scrollback {key} is unreadable: {error}");
            return Ok(Vec::new());
        }
    };
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Ok(Vec::new());
    }
    if metadata.len() > MAX_SCROLLBACK_BYTES as u64 {
        return Err("scrollback is too large to restore".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_SCROLLBACK_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_SCROLLBACK_BYTES {
        return Err("scrollback is too large to restore".into());
    }
    Ok(bytes)
}

/// Deletes every file whose key is not listed, including temporary files left
/// by an interrupted save, and returns how many went. Subdirectories are left
/// alone: nothing here creates them.
fn retain(root: &Path, keys: &[String]) -> Result<usize, String> {
    validate_root(root)?;
    if keys.len() > MAX_RETAINED_KEYS {
        return Err("too many scrollback keys".into());
    }
    let keep: HashSet<&str> = keys
        .iter()
        .map(String::as_str)
        .filter(|key| valid_key(key))
        .collect();
    let dir = match open_directory(&directory(root)) {
        Ok(dir) => dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.to_string()),
    };
    let entries = dir.entries().map_err(|e| e.to_string())?;
    let mut removed = 0;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let kept = name
            .to_str()
            .and_then(key_of)
            .is_some_and(|key| keep.contains(key));
        if kept {
            continue;
        }
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            continue;
        }
        match dir.remove_file(&name) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log::warn!("could not remove stale scrollback {name:?}: {error}"),
        }
    }
    Ok(removed)
}

fn checked_window_root(root: &Path, label: &str) -> Result<PathBuf, String> {
    validate_root(root)?;
    if label != windows::MAIN {
        for path in [root.join("windows"), windows::data_root(root, label)] {
            match fs::symlink_metadata(path) {
                Ok(meta) if meta.is_dir() => {},
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Ok(_) => return Err("Window state directory is not a plain directory".into()),
                Err(error) => return Err(error.to_string()),
            }
        }
    }
    Ok(windows::data_root(root, label))
}

/// The calling window's scrollback lives under this root.
fn data_dir(app: &tauri::AppHandle, webview: &tauri::Webview) -> Result<PathBuf, String> {
    let label = webview.label();
    if !windows::is_app_window(label) || !windows::keeps_state(app, label) {
        return Err("scrollback is kept for open app windows only".into());
    }
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    checked_window_root(&root, label)
}

/// Body: the scrollback as UTF-8 bytes; empty deletes it. Header
/// `x-oarlock-scrollback`: the pane's key.
#[tauri::command]
pub async fn terminal_scrollback_save(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, ScrollbackState>,
    request: Request<'_>,
) -> Result<(), String> {
    let key = request
        .headers()
        .get(KEY_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|key| valid_key(key))
        .ok_or("missing or invalid scrollback key")?
        .to_owned();
    let bytes = ipc_body::bytes_of(request.body(), MAX_SCROLLBACK_BYTES, MAX_SCROLLBACK_BYTES)?
        .into_owned();
    let root = data_dir(&app, &webview)?;
    let guard = state.gate.clone().lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        save(&root, &key, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The pane's saved scrollback as raw bytes; an empty body means none.
#[tauri::command]
pub async fn terminal_scrollback_load(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, ScrollbackState>,
    key: String,
) -> Result<Response, String> {
    let root = data_dir(&app, &webview)?;
    let guard = state.gate.clone().lock_owned().await;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        load(&root, &key)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

/// Keeps the listed panes' files and deletes the rest; returns how many went.
#[tauri::command]
pub async fn terminal_scrollback_retain(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, ScrollbackState>,
    keys: Vec<String>,
) -> Result<usize, String> {
    let root = data_dir(&app, &webview)?;
    let guard = state.gate.clone().lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        retain(&root, &keys)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(directory(root))
            .map(|entries| {
                entries
                    .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn terminal_scrollback_keys_are_short_plain_identifiers() {
        let longest = "k".repeat(128);
        let too_long = "k".repeat(129);
        for good in ["a", "sb-mh3k2f-1a2b3c", "A_b-9", longest.as_str()] {
            assert!(valid_key(good), "{good}");
        }
        for bad in [
            "",
            too_long.as_str(),
            "..",
            "../x",
            "a/b",
            "a\\b",
            "a.vt",
            "a b",
            "é",
            "a\0",
            "C:x",
        ] {
            assert!(!valid_key(bad), "{bad:?}");
            assert!(scrollback_path(Path::new("/root"), bad).is_err(), "{bad:?}");
        }
        assert_eq!(key_of("abc.vt"), Some("abc"));
        assert_eq!(key_of(".tmpX1y2z3"), None);
        assert_eq!(key_of("abc.vt.tmp"), None);
        assert_eq!(key_of("a.b.vt"), None);
        assert_eq!(key_of(".vt"), None);
    }

    #[test]
    fn terminal_scrollback_saves_atomically_loads_and_deletes() {
        let root = tempfile::tempdir().unwrap();
        assert!(load(root.path(), "one").unwrap().is_empty());
        save(root.path(), "one", "old \x1b[31mred\x1b[0m".as_bytes()).unwrap();
        save(root.path(), "two", b"other").unwrap();
        save(root.path(), "one", "new é".as_bytes()).unwrap();
        assert_eq!(load(root.path(), "one").unwrap(), "new é".as_bytes());
        assert_eq!(load(root.path(), "two").unwrap(), b"other");
        assert_eq!(
            names(root.path()),
            ["one.vt", "two.vt"],
            "no temporary files"
        );

        save(root.path(), "one", b"").unwrap();
        assert!(load(root.path(), "one").unwrap().is_empty());
        save(root.path(), "one", b"").unwrap();
        assert_eq!(names(root.path()), ["two.vt"]);
    }

    #[cfg(unix)]
    #[test]
    fn terminal_scrollback_files_and_directory_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        save(root.path(), "one", b"history").unwrap();
        let mode = |path: PathBuf| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(scrollback_path(root.path(), "one").unwrap()), 0o600);
        assert_eq!(mode(directory(root.path())), 0o700);
    }

    #[test]
    fn terminal_scrollback_refuses_oversized_and_non_utf8_bodies() {
        let root = tempfile::tempdir().unwrap();
        save(root.path(), "one", b"kept").unwrap();
        let limit = vec![b'x'; MAX_SCROLLBACK_BYTES];
        save(root.path(), "two", &limit).unwrap();
        assert_eq!(
            load(root.path(), "two").unwrap().len(),
            MAX_SCROLLBACK_BYTES
        );

        let over = vec![b'x'; MAX_SCROLLBACK_BYTES + 1];
        assert!(save(root.path(), "one", &over).is_err());
        assert!(save(root.path(), "one", &[b'a', 0xff, b'b']).is_err());
        assert!(save(root.path(), "../one", b"x").is_err());
        assert_eq!(
            load(root.path(), "one").unwrap(),
            b"kept",
            "refusals keep the old file"
        );

        fs::write(scrollback_path(root.path(), "big").unwrap(), &over).unwrap();
        assert!(load(root.path(), "big").is_err());
    }

    #[test]
    fn terminal_scrollback_retain_deletes_unlisted_and_stray_files() {
        let root = tempfile::tempdir().unwrap();
        for key in ["keep", "closed", "deleted-space"] {
            save(root.path(), key, key.as_bytes()).unwrap();
        }
        let dir = directory(root.path());
        fs::write(dir.join(".tmpAbC123"), b"interrupted save").unwrap();
        fs::write(dir.join("notes.txt"), b"foreign").unwrap();
        fs::create_dir(dir.join("nested")).unwrap();

        let removed = retain(
            root.path(),
            &["keep".into(), "../escape".into(), "never-saved".into()],
        )
        .unwrap();
        assert_eq!(removed, 4);
        assert_eq!(names(root.path()), ["keep.vt", "nested"]);
        assert_eq!(load(root.path(), "keep").unwrap(), b"keep");

        assert_eq!(retain(root.path(), &[]).unwrap(), 1);
        assert_eq!(names(root.path()), ["nested"]);
    }

    #[test]
    fn terminal_scrollback_retain_without_a_directory_or_with_too_many_keys() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(retain(root.path(), &[]).unwrap(), 0);

        save(root.path(), "keep", b"x").unwrap();
        let flood: Vec<String> = (0..=MAX_RETAINED_KEYS).map(|n| format!("k{n}")).collect();
        assert!(retain(root.path(), &flood).is_err());
        assert_eq!(
            names(root.path()),
            ["keep.vt"],
            "a refused list deletes nothing"
        );
    }

    #[cfg(unix)]
    #[test]
    fn terminal_scrollback_never_follows_a_link() {
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().join("secret.txt");
        fs::write(&outside, b"secret").unwrap();
        create_directory(&directory(root.path())).unwrap();
        let link = scrollback_path(root.path(), "linked").unwrap();
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        assert!(load(root.path(), "linked").unwrap().is_empty());
        assert!(save(root.path(), "linked", b"history").is_err());
        assert_eq!(
            fs::read(&outside).unwrap(),
            b"secret",
            "the target is untouched"
        );
        assert!(load(root.path(), "linked").unwrap().is_empty());

        std::os::unix::fs::symlink(&outside, directory(root.path()).join("other.vt")).unwrap();
        assert_eq!(retain(root.path(), &[]).unwrap(), 2);
        assert_eq!(fs::read(&outside).unwrap(), b"secret");
    }

    #[cfg(unix)]
    #[test]
    fn linked_scrollback_or_window_directories_cannot_redirect_operations() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("pane.vt");
        fs::write(&target, b"private").unwrap();
        symlink(outside.path(), directory(root.path())).unwrap();
        assert!(load(root.path(), "pane").unwrap().is_empty());
        assert!(save(root.path(), "pane", b"changed").is_err());
        assert!(save(root.path(), "pane", b"").is_err());
        assert!(retain(root.path(), &[]).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"private");

        let linked_root = root.path().join("window");
        symlink(outside.path(), &linked_root).unwrap();
        assert!(load(&linked_root, "pane").is_err());
        assert!(save(&linked_root, "pane", b"changed").is_err());
        assert!(retain(&linked_root, &[]).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"private");
    }

    #[cfg(unix)]
    #[test]
    fn linked_windows_parent_is_refused_before_access() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(outside.path().join("w-1")).unwrap();
        symlink(outside.path(), root.path().join("windows")).unwrap();
        assert!(checked_window_root(root.path(), "w-1").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_is_never_opened_as_scrollback() {
        use std::os::unix::ffi::OsStrExt;
        let root = tempfile::tempdir().unwrap();
        create_directory(&directory(root.path())).unwrap();
        let fifo = scrollback_path(root.path(), "pipe").unwrap();
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        let path = root.path().to_path_buf();
        std::thread::spawn(move || { let _ = tx.send(load(&path, "pipe")); });
        assert!(rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap().unwrap().is_empty());
    }
}
