use tauri::AppHandle;

#[cfg(windows)]
pub(crate) use platform::read_snapshot_paths;
#[cfg(target_os = "macos")]
pub(crate) use platform::read_snapshot_paths;

#[tauri::command]
pub async fn fs_clipboard_paths(app: AppHandle) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(platform::read_file_paths)
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            #[cfg(target_os = "linux")]
            platform::request_file_paths(tx);
            #[cfg(not(target_os = "linux"))]
            let _ = tx.send(platform::read_file_paths());
        })
        .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(5))
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "clipboard read timed out or was cancelled".to_string())?
    }
}

/// The `file:` URIs in a `text/uri-list` or `x-special/gnome-copied-files`
/// payload; skips the latter's leading `copy`/`cut` verb and uri-list comments.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn file_uri_lines(text: &str) -> impl Iterator<Item = &str> {
    text.lines().map(str::trim).filter(|line| {
        line.get(..5)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:"))
    })
}

#[cfg(target_os = "macos")]
mod platform {
    use crate::modules::fs::to_canon;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
    use objc2_foundation::NSURL;

    pub fn read_file_paths() -> Result<Vec<String>, String> {
        read_paths(false)
    }
    pub fn read_snapshot_paths() -> Result<Vec<String>, String> {
        read_paths(true)
    }
    fn read_paths(strict: bool) -> Result<Vec<String>, String> {
        let pasteboard = NSPasteboard::generalPasteboard();
        let Some(items) = pasteboard.pasteboardItems() else {
            return Ok(Vec::new());
        };
        let file_type = unsafe { NSPasteboardTypeFileURL };
        let mut paths = Vec::new();
        for item in items.iter() {
            let Some(raw) = item.stringForType(file_type) else {
                continue;
            };
            // Resolve Finder's file-reference URL before validation. A file offered
            // without a usable path must never fall back to its clipboard pixels.
            let path = NSURL::URLWithString(&raw)
                .and_then(|url| url.filePathURL())
                .and_then(|url| url.path())
                .map(|path| path.to_string())
                .filter(|path| !path.is_empty());
            match path {
                Some(path) => paths.push(to_canon(path)),
                None if strict => {
                    return Err(
                        "Clipboard file path could not be resolved. Use the file picker instead."
                            .into(),
                    )
                }
                None => {}
            }
        }
        Ok(paths)
    }
}

#[cfg(windows)]
mod platform {
    use crate::modules::fs::to_canon;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::System::Ole::CF_HDROP;
    use windows_sys::Win32::UI::Shell::DragQueryFileW;

    // Another app may hold the clipboard open for a moment; retry briefly.
    fn open_clipboard() -> bool {
        for _ in 0..5 {
            if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        false
    }

    struct ClipboardGuard;

    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe { CloseClipboard() };
        }
    }

    pub fn read_file_paths() -> Result<Vec<String>, String> {
        read_paths(false)
    }
    pub fn read_snapshot_paths() -> Result<Vec<String>, String> {
        read_paths(true)
    }
    fn read_paths(strict: bool) -> Result<Vec<String>, String> {
        if !open_clipboard() {
            return Err("clipboard is busy; try pasting again".into());
        }
        let _guard = ClipboardGuard;
        let mut paths = Vec::new();
        // The handle is owned by the clipboard; it must not be freed here.
        let offered = unsafe { IsClipboardFormatAvailable(u32::from(CF_HDROP)) } != 0;
        let hdrop = unsafe { GetClipboardData(u32::from(CF_HDROP)) };
        if !hdrop.is_null() {
            let count = unsafe { DragQueryFileW(hdrop, u32::MAX, std::ptr::null_mut(), 0) };
            for index in 0..count {
                let len = unsafe { DragQueryFileW(hdrop, index, std::ptr::null_mut(), 0) };
                if len == 0 {
                    if strict {
                        return Err("Clipboard file path could not be read".into());
                    }
                    continue;
                }
                let mut buf = vec![0u16; len as usize + 1];
                let written =
                    unsafe { DragQueryFileW(hdrop, index, buf.as_mut_ptr(), buf.len() as u32) };
                if strict && written != len {
                    return Err("Clipboard file path could not be read".into());
                }
                buf.truncate(written as usize);
                if !buf.is_empty() {
                    paths.push(to_canon(OsString::from_wide(&buf)));
                }
            }
        }
        if strict && offered && paths.is_empty() {
            return Err("Clipboard file paths could not be read".into());
        }
        Ok(paths)
    }
}

#[cfg(target_os = "linux")]
pub(crate) mod platform {
    use crate::modules::fs::to_canon;
    use gtk::{gdk, glib};

    fn local_paths(uris: &[glib::GString]) -> Vec<String> {
        uris.iter()
            .filter_map(|uri| glib::filename_from_uri(uri).ok())
            .filter(|(_, host)| {
                host.as_deref()
                    .is_none_or(|host| host.is_empty() || host.eq_ignore_ascii_case("localhost"))
            })
            .map(|(path, _)| to_canon(path))
            .collect()
    }

    fn snapshot_paths(uris: &[glib::GString], strict: bool) -> Result<Vec<String>, String> {
        let paths = local_paths(uris);
        let files = uris
            .iter()
            .filter(|uri| {
                uri.get(..5)
                    .is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:"))
            })
            .count();
        if strict && paths.len() != files {
            return Err("Clipboard contains a file without a usable local path. Use the file picker instead.".into());
        }
        Ok(paths)
    }

    pub fn request_file_paths(tx: std::sync::mpsc::Sender<Result<Vec<String>, String>>) {
        request_paths(false, move |paths| {
            let _ = tx.send(paths);
        });
    }

    pub(crate) fn request_paths(
        strict: bool,
        done: impl FnOnce(Result<Vec<String>, String>) + 'static,
    ) {
        let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
        clipboard.request_uris(move |clipboard, uris| {
            if !uris.is_empty() {
                done(snapshot_paths(uris, strict));
                return;
            }
            clipboard.request_contents(
                &gdk::Atom::intern("x-special/gnome-copied-files"),
                move |_, selection| {
                    if selection.length() <= 0 {
                        done(Ok(Vec::new()));
                        return;
                    }
                    let text = String::from_utf8_lossy(&selection.data()).into_owned();
                    let uris: Vec<glib::GString> =
                        super::file_uri_lines(&text).map(Into::into).collect();
                    if strict && uris.is_empty() {
                        done(Err("Clipboard file paths could not be read".into()));
                    } else {
                        done(snapshot_paths(&uris, strict));
                    }
                },
            );
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn decodes_local_uris_without_treating_remote_hosts_as_local_paths() {
            let uris: Vec<glib::GString> = [
                "file:///tmp/My%20File",
                "file://localhost/tmp/local",
                "file://remote-server/tmp/remote",
                "https://example.com/file",
            ]
            .into_iter()
            .map(Into::into)
            .collect();
            assert_eq!(local_paths(&uris), ["/tmp/My File", "/tmp/local"]);
            assert!(snapshot_paths(&uris, true).is_err());
            assert_eq!(
                snapshot_paths(&uris[..2], true).unwrap(),
                ["/tmp/My File", "/tmp/local"]
            );
            // Web image copies can include an ordinary URL alongside pixels.
            assert!(snapshot_paths(&uris[3..], true).unwrap().is_empty());
        }
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
mod platform {
    pub fn read_file_paths() -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::file_uri_lines;

    #[test]
    fn file_uri_lines_reads_gnome_and_uri_list_payloads() {
        let gnome = "copy\nfile:///home/a/x.txt\nfile:///home/a/My%20Dir";
        assert_eq!(
            file_uri_lines(gnome).collect::<Vec<_>>(),
            ["file:///home/a/x.txt", "file:///home/a/My%20Dir"]
        );
        let uri_list = "# comment\r\nfile:///tmp/a\r\nhttps://example.com\r\n\r\n";
        assert_eq!(
            file_uri_lines(uri_list).collect::<Vec<_>>(),
            ["file:///tmp/a"]
        );
    }
}
