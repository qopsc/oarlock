//! Native file attachment import. No content is read until the opened handle passes policy.
use crate::modules::{
    base64, secret_paths,
    workspace::{resolve_path, Opened, Origin, WorkspaceEnv, WorkspaceRegistry},
};
use serde::Serialize;
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
use tauri::Manager;

const MAX_TEXT: usize = 200_000;
const MAX_IMAGE: usize = 15 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Attachment {
    Text {
        name: String,
        content: String,
        size: usize,
    },
    Image {
        name: String,
        media_type: String,
        data: String,
        size: usize,
    },
}
fn allowed(path: &Path) -> Result<(), String> {
    if !secret_paths::readable(path) {
        return Err("Refused: attachment path contains sensitive files or directories".into());
    }
    Ok(())
}

/// Signatures such as `P1` and `BM` are also ordinary prose. Prefer valid text
/// when the name does not identify an image. Extensions missing from `image`
/// only select the webview conversion path; they never bypass path validation.
fn image_type(name: &str, bytes: &[u8]) -> Option<&'static str> {
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let browser_type = match extension.as_str() {
        "heic" | "heics" => Some("image/heic"),
        "heif" | "heifs" => Some("image/heif"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    };
    let named_image =
        browser_type.is_some() || image::ImageFormat::from_extension(&extension).is_some();
    if !named_image && !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok() {
        return None;
    }
    image::guess_format(bytes)
        .ok()
        .map(|format| format.to_mime_type())
        .or(browser_type)
}

#[cfg(target_os = "linux")]
pub(crate) fn handle_path(file: &File) -> Result<PathBuf, String> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(|e| e.to_string())
}
#[cfg(target_os = "macos")]
pub(crate) fn handle_path(file: &File) -> Result<PathBuf, String> {
    use std::os::{fd::AsRawFd, unix::ffi::OsStringExt};
    let mut buffer = vec![0u8; libc::PATH_MAX as usize];
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let end = buffer
        .iter()
        .position(|b| *b == 0)
        .ok_or("Invalid opened attachment path")?;
    buffer.truncate(end);
    Ok(PathBuf::from(std::ffi::OsString::from_vec(buffer)))
}
#[cfg(windows)]
pub(crate) fn handle_path(file: &File) -> Result<PathBuf, String> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut buffer = vec![0u16; 32768];
    let size = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    } as usize;
    if size == 0 || size >= buffer.len() {
        return Err("Could not validate opened attachment path".into());
    }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..size],
    )))
}

fn read_opened(
    file: File,
    name: String,
    authorize: impl Fn(&Path) -> Result<(), String>,
) -> Result<Attachment, String> {
    let opened = handle_path(&file)?;
    allowed(&opened)?;
    authorize(&opened)?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("Only regular files can be attached".into());
    }
    if meta.len() > MAX_IMAGE as u64 {
        return Err("Attachment exceeds the 15 MiB source limit".into());
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take((MAX_IMAGE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_IMAGE {
        return Err("Attachment exceeds the 15 MiB source limit".into());
    }
    let size = bytes.len();
    if let Some(media_type) = image_type(&name, &bytes) {
        return Ok(Attachment::Image {
            name,
            media_type: media_type.into(),
            data: base64::base64(&bytes),
            size,
        });
    }
    if size > MAX_TEXT {
        return Err("Text attachment exceeds the 200 KB limit".into());
    }
    if bytes.contains(&0) {
        return Err("This file is not supported text or an image".into());
    }
    let content =
        String::from_utf8(bytes).map_err(|_| "This file is not UTF-8 text or a supported image")?;
    Ok(Attachment::Text {
        name,
        content,
        size,
    })
}
fn import(
    path: &Path,
    authorize: impl Fn(&Path) -> Result<(), String>,
) -> Result<Attachment, String> {
    if !path.is_absolute() {
        return Err("Attachment paths must be absolute".into());
    }
    allowed(path)?;
    let real = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    allowed(&real)?;
    authorize(&real)?;
    let file = crate::modules::project_trust::open_regular(&real).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .ok_or("Attachment has no filename")?
        .to_string_lossy()
        .into_owned();
    read_opened(file, name, authorize)
}
#[tauri::command]
pub async fn ai_import_attachment(
    app: tauri::AppHandle,
    path: String,
    workspace: Option<WorkspaceEnv>,
    picked: bool,
) -> Result<Attachment, String> {
    super::blocking(move || {
        allowed(Path::new(&path))?;
        let path = resolve_path(&path, &WorkspaceEnv::from_option(workspace))?;
        let registry = app.state::<WorkspaceRegistry>();
        let granted = std::cell::Cell::new(false);
        import(&path, |real| {
            if picked && !granted.replace(true) {
                registry
                    .authorize_opened(real, Opened::File)
                    .map_err(|e| e.to_string())?;
            }
            registry
                .gates(Origin::Ai)
                .authorized_existing(real)
                .map(|_| ())
        })
    })
    .await
}
/// The OS picker selects host paths, regardless of the current space's environment.
#[tauri::command]
pub async fn ai_pick_attachment_files(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, String> {
    super::blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .file()
            .set_parent(&window)
            .set_title("Attach files to chat")
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|file| {
                file.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .collect()
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_text_is_not_an_image_because_of_its_first_letters() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("review.md");
        for text in [
            "P1: fix the crash",
            "BMP example",
            "GIF89a is a format",
            "DDS documentation",
        ] {
            std::fs::write(&path, text).unwrap();
            assert!(
                matches!(import(&path, |_| Ok(())).unwrap(), Attachment::Text { content, .. } if content == text)
            );
        }
        assert_eq!(
            image_type("no-extension", b"\x89PNG\r\n\x1a\n"),
            Some("image/png")
        );
        assert_eq!(
            image_type("drawing.pbm", b"P1\n1 1\n0\n"),
            Some("image/x-portable-anymap")
        );
    }
    #[test]
    fn browser_decoded_image_types_reach_the_conversion_path() {
        let dir = tempfile::tempdir().unwrap();
        for (name, bytes, mime) in [
            (
                "photo.heic",
                b"\0\0\0\x18ftypheic\0\0\0\0heicmif1".as_slice(),
                "image/heic",
            ),
            (
                "diagram.svg",
                b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".as_slice(),
                "image/svg+xml",
            ),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            assert!(
                matches!(import(&path, |_| Ok(())).unwrap(), Attachment::Image { media_type, .. } if media_type == mime)
            );
        }
    }
    #[test]
    fn imports_text_and_detects_images_from_bytes() {
        assert!(import(Path::new("relative.txt"), |_| Ok(())).is_err());
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().join("notes.txt");
        std::fs::write(&text, "hello").unwrap();
        assert!(
            matches!(import(&text, |_| Ok(())).unwrap(), Attachment::Text { content, .. } if content == "hello")
        );
        let image = dir.path().join("picture.txt");
        std::fs::write(&image, b"\x89PNG\r\n\x1a\n").unwrap();
        assert!(
            matches!(import(&image, |_| Ok(())).unwrap(), Attachment::Image { media_type, .. } if media_type == "image/png")
        );
    }
    #[test]
    fn denies_secrets_and_unauthorized_files_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        for name in [".env", "credentials", "id_ed25519", "secret.key"] {
            let path = dir.path().join(name);
            std::fs::write(&path, "synthetic").unwrap();
            assert!(import(&path, |_| panic!("secret must be refused first")).is_err());
        }
        let path = dir.path().join("ordinary.txt");
        std::fs::write(&path, "data").unwrap();
        assert_eq!(
            import(&path, |_| Err("outside".into())).unwrap_err(),
            "outside"
        );
    }
    #[cfg(unix)]
    #[test]
    fn denies_symlinks_and_opened_handles_into_protected_directories() {
        let dir = tempfile::tempdir().unwrap();
        let ssh = dir.path().join(".ssh");
        std::fs::create_dir(&ssh).unwrap();
        let secret = ssh.join("ordinary.txt");
        std::fs::write(&secret, "synthetic").unwrap();
        let link = dir.path().join("innocent.txt");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        assert!(import(&link, |_| Ok(())).is_err());
        assert!(
            read_opened(File::open(&secret).unwrap(), "innocent.txt".into(), |_| Ok(
                ()
            ))
            .is_err()
        );
        // Swap an ordinary path after canonical validation but before open.
        let swapped = dir.path().join("swapped.txt");
        std::fs::write(&swapped, "safe").unwrap();
        assert!(import(&swapped, |_| {
            std::fs::remove_file(&swapped).unwrap();
            std::os::unix::fs::symlink(&secret, &swapped).unwrap();
            Ok(())
        })
        .is_err());
    }
    #[test]
    fn enforces_size_and_regular_file_limits() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("large.txt");
        std::fs::write(&file, vec![b'x'; MAX_TEXT + 1]).unwrap();
        assert!(import(&file, |_| Ok(())).is_err());
        File::create(&file)
            .unwrap()
            .set_len(MAX_IMAGE as u64 + 1)
            .unwrap();
        assert!(import(&file, |_| Ok(())).is_err());
        assert!(import(dir.path(), |_| Ok(())).is_err());
    }
}
