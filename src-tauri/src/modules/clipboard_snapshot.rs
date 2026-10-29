//! One clipboard capture for an AI paste. File paths and pixels must belong to
//! the same clipboard generation; a changed clipboard is never retried silently.
use tauri::ipc::Response;

const CHANGED: &str = "Clipboard changed while pasting. Paste again to use its new contents.";
const MAX_PIXELS: usize = 128 * 1024 * 1024; // 512 MiB RGBA, matching clipboard image writes.

enum Capture {
    Files(Vec<String>),
    #[cfg(any(target_os = "linux", test))]
    Pixels(Pixels),
    #[cfg(any(target_os = "macos", windows))]
    Png(Vec<u8>),
    Empty,
}
#[cfg(any(target_os = "linux", test))]
struct Pixels {
    bytes: Vec<u8>,
    width: usize,
    height: usize,
    stride: usize,
    channels: usize,
}
#[cfg(any(target_os = "linux", test))]
impl Pixels {
    fn rgba(self) -> Result<(Vec<u8>, u32, u32), String> {
        let Self {
            bytes,
            width,
            height,
            stride,
            channels,
        } = self;
        let count = width
            .checked_mul(height)
            .filter(|n| *n > 0 && *n <= MAX_PIXELS)
            .ok_or("Clipboard image is too large or invalid")?;
        if width > 16_384 || height > 16_384 || ![3, 4].contains(&channels) {
            return Err("Clipboard image dimensions or channels are invalid".into());
        }
        let row = width * channels;
        let required = stride
            .checked_mul(height - 1)
            .and_then(|n| n.checked_add(row))
            .ok_or("Clipboard image stride is invalid")?;
        if stride < row || bytes.len() < required {
            return Err("Clipboard image pixels are incomplete".into());
        }
        if channels == 4 && stride == row && bytes.len() == count * 4 {
            return Ok((bytes, width as u32, height as u32));
        }
        let mut rgba = Vec::with_capacity(count * 4);
        for y in 0..height {
            for pixel in bytes[y * stride..y * stride + row].chunks_exact(channels) {
                rgba.extend_from_slice(&pixel[..3]);
                rgba.push(if channels == 4 { pixel[3] } else { 255 });
            }
        }
        Ok((rgba, width as u32, height as u32))
    }
}
// Binary frame: 0 empty; 1 PNG bytes; 2 UTF-8 JSON paths. No base64 image copy.
fn wire(kind: u8, mut bytes: Vec<u8>) -> Vec<u8> {
    bytes.insert(0, kind);
    bytes
}
fn finish(capture: Capture) -> Result<Response, String> {
    let bytes = match capture {
        Capture::Files(paths) => wire(2, serde_json::to_vec(&paths).map_err(|e| e.to_string())?),
        Capture::Empty => vec![0],
        #[cfg(any(target_os = "macos", windows))]
        Capture::Png(png) => wire(1, png),
        #[cfg(any(target_os = "linux", test))]
        Capture::Pixels(pixels) => {
            let (rgba, width, height) = pixels.rgba()?;
            wire(1, super::clipboard_image::encode_png(&rgba, width, height)?)
        }
    };
    Ok(Response::new(bytes))
}

#[cfg(any(target_os = "macos", windows, test))]
fn capture_versioned(
    start: u64,
    revision: impl Fn() -> Result<u64, String>,
    paths: impl FnOnce() -> Result<Vec<String>, String>,
    pixels: impl FnOnce() -> Result<Capture, String>,
) -> Result<Capture, String> {
    if revision()? != start {
        return Err(CHANGED.into());
    }
    let files = paths()?;
    if revision()? != start {
        return Err(CHANGED.into());
    }
    if !files.is_empty() {
        return Ok(Capture::Files(files));
    }
    let image = pixels()?;
    if revision()? != start {
        return Err(CHANGED.into());
    }
    Ok(image)
}

#[tauri::command]
pub async fn ai_clipboard_snapshot(app: tauri::AppHandle) -> Result<Response, String> {
    #[cfg(any(target_os = "macos", windows))]
    {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        // Fix the generation before waiting for a blocking worker.
        let start = revision()?;
        tauri::async_runtime::spawn_blocking(move || {
            let captured = capture_versioned(
                start,
                revision,
                super::fs::clipboard::read_snapshot_paths,
                || {
                    match app.clipboard().read_image() {
                        Ok(image) => {
                            let count = u64::from(image.width()) * u64::from(image.height());
                            if count == 0
                                || count > MAX_PIXELS as u64
                                || image.width() > 16_384
                                || image.height() > 16_384
                            {
                                return Err("Clipboard image is too large or invalid".into());
                            }
                            super::clipboard_image::encode_png(
                                image.rgba(),
                                image.width(),
                                image.height(),
                            )
                            .map(Capture::Png)
                        }
                        // The clipboard plugin reports absence as an error, like its existing image read.
                        Err(_) => Ok(Capture::Empty),
                    }
                },
            )?;
            finish(captured)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(target_os = "linux")]
    {
        let capture = linux::capture(&app).await?;
        tauri::async_runtime::spawn_blocking(move || finish(capture))
            .await
            .map_err(|e| e.to_string())?
    }
}
#[cfg(target_os = "macos")]
fn revision() -> Result<u64, String> {
    Ok(objc2_app_kit::NSPasteboard::generalPasteboard().changeCount() as u64)
}
#[cfg(windows)]
fn revision() -> Result<u64, String> {
    let number = unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() };
    if number == 0 {
        return Err("Could not verify clipboard contents. Copy again and retry Paste.".into());
    }
    Ok(u64::from(number))
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use gtk::{gdk, glib, prelude::*};
    use std::{cell::RefCell, rc::Rc};
    type ResultSender = tokio::sync::oneshot::Sender<Result<Capture, String>>;
    struct Pending {
        clipboard: gtk::Clipboard,
        signal: Option<glib::SignalHandlerId>,
        timer: Option<glib::SourceId>,
        sender: Option<ResultSender>,
    }
    fn finish_pending(pending: &Rc<RefCell<Pending>>, result: Result<Capture, String>) {
        let mut state = pending.borrow_mut();
        if let Some(signal) = state.signal.take() {
            state.clipboard.disconnect(signal);
        }
        if let Some(timer) = state.timer.take() {
            timer.remove();
        }
        if let Some(sender) = state.sender.take() {
            let _ = sender.send(result);
        }
    }
    pub async fn capture(app: &tauri::AppHandle) -> Result<Capture, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || start(tx))
            .map_err(|e| e.to_string())?;
        rx.await
            .map_err(|_| "Clipboard capture was cancelled".to_string())?
    }
    fn start(sender: ResultSender) {
        let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
        if !clipboard
            .display()
            .is_some_and(|display| display.supports_selection_notification())
        {
            let _ = sender.send(Err(
                "This display cannot verify clipboard changes. Use the file picker instead.".into(),
            ));
            return;
        }
        let pending = Rc::new(RefCell::new(Pending {
            clipboard: clipboard.clone(),
            signal: None,
            timer: None,
            sender: Some(sender),
        }));
        // gtk-rs omits the typed wrapper for this signal's GdkEventOwnerChange.
        // We need only notification, not the event payload.
        let weak = Rc::downgrade(&pending);
        pending.borrow_mut().signal =
            Some(clipboard.connect_local("owner-change", false, move |_| {
                if let Some(pending) = weak.upgrade() {
                    finish_pending(&pending, Err(CHANGED.into()));
                }
                None
            }));
        let timeout = pending.clone();
        pending.borrow_mut().timer = Some(glib::timeout_add_local_once(
            std::time::Duration::from_secs(5),
            move || {
                timeout.borrow_mut().timer.take();
                finish_pending(
                    &timeout,
                    Err("Clipboard capture timed out. Try pasting again.".into()),
                );
            },
        ));
        super::super::fs::clipboard::platform::request_paths(true, move |result| {
            if pending.borrow().sender.is_none() {
                return;
            }
            let paths = match result {
                Ok(paths) => paths,
                Err(error) => {
                    finish_pending(&pending, Err(error));
                    return;
                }
            };
            if !paths.is_empty() {
                finish_pending(&pending, Ok(Capture::Files(paths)));
                return;
            }
            let clipboard = pending.borrow().clipboard.clone();
            clipboard.request_image(move |_, image| {
                if pending.borrow().sender.is_none() {
                    return;
                }
                let captured = match image {
                    None => Ok(Capture::Empty),
                    Some(image) => {
                        let size = (image.width() as usize).checked_mul(image.height() as usize);
                        if image.width() <= 0
                            || image.height() <= 0
                            || size.is_none_or(|size| size > MAX_PIXELS)
                            || image.width() > 16_384
                            || image.height() > 16_384
                        {
                            Err("Clipboard image is too large or invalid".into())
                        } else {
                            Ok(Capture::Pixels(Pixels {
                                bytes: image.read_pixel_bytes().as_ref().to_vec(),
                                width: image.width() as usize,
                                height: image.height() as usize,
                                stride: image.rowstride() as usize,
                                channels: image.n_channels() as usize,
                            }))
                        }
                    }
                };
                finish_pending(&pending, captured);
            });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn a_queued_capture_rejects_changes_before_a_worker_starts_reading() {
        let requested_revision = 1;
        let current_revision = 2;
        assert!(capture_versioned(
            requested_revision,
            || Ok(current_revision),
            || panic!("a queued paste must not read the new clipboard's paths"),
            || panic!("a queued paste must not read the new clipboard's pixels"),
        )
        .is_err());
    }
    #[test]
    fn changed_clipboard_is_rejected_before_fallback_and_after_pixel_capture() {
        let revision = Cell::new(1);
        assert!(capture_versioned(
            revision.get(),
            || Ok(revision.get()),
            || {
                revision.set(2);
                Ok(vec![])
            },
            || panic!("no fallback after change")
        )
        .is_err());
        assert!(capture_versioned(
            revision.get(),
            || Ok(revision.get()),
            || Ok(vec![]),
            || {
                revision.set(3);
                Ok(Capture::Empty)
            }
        )
        .is_err());
    }
    #[test]
    fn copied_files_never_fall_back_to_pixels_and_stable_empty_is_allowed() {
        assert!(matches!(
            capture_versioned(
                1,
                || Ok(1),
                || Ok(vec!["/tmp/.env".into()]),
                || panic!("file must be validated separately")
            )
            .unwrap(),
            Capture::Files(_)
        ));
        assert!(matches!(
            capture_versioned(1, || Ok(1), || Ok(vec![]), || Ok(Capture::Empty)).unwrap(),
            Capture::Empty
        ));
        assert!(
            capture_versioned(1, || Err("unavailable".into()), || panic!(), || panic!()).is_err()
        );
        assert!(capture_versioned(
            1,
            || Ok(1),
            || Err("unusable file path".into()),
            || panic!("no image fallback for invalid files")
        )
        .is_err());
    }
    #[test]
    fn pixel_rows_handle_rgb_padding_and_alpha_without_copying_padding() {
        assert!(finish(Capture::Pixels(Pixels {
            bytes: vec![1, 2, 3, 255],
            width: 1,
            height: 1,
            stride: 4,
            channels: 4,
        }))
        .is_ok());
        assert_eq!(wire(2, b"[]".to_vec()), b"\x02[]");
        let (rgba, w, h) = Pixels {
            bytes: vec![1, 2, 3, 0, 4, 5, 6],
            width: 1,
            height: 2,
            stride: 4,
            channels: 3,
        }
        .rgba()
        .unwrap();
        assert_eq!((w, h), (1, 2));
        assert_eq!(rgba, [1, 2, 3, 255, 4, 5, 6, 255]);
        assert!(Pixels {
            bytes: vec![0; 3],
            width: 1,
            height: 1,
            stride: 4,
            channels: 4
        }
        .rgba()
        .is_err());
    }
}
