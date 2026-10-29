//! Version-checked terminal clipboard snapshots. A cached image is reused only
//! after the OS version has been checked around this capture's text read.
use super::net::page::NetworkPages;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Response, Manager};

const CHANGED: &str = "Clipboard changed while reading. Paste again to use its new contents.";
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImageRequest {
    Never,
    Always,
    IfEmpty,
}
impl ImageRequest {
    fn wanted(self, text: &str, primary: bool) -> bool {
        !primary
            && match self {
                Self::Never => false,
                Self::Always => true,
                Self::IfEmpty => text.is_empty(),
            }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
enum ImageStatus {
    Omitted,
    Reuse,
    Empty,
    Png,
}
#[derive(Serialize)]
struct Header {
    revision: String,
    text: Option<String>,
    image: ImageStatus,
    #[serde(rename = "focusRequired")]
    focus_required: bool,
}
struct Snapshot {
    header: Header,
    png: Vec<u8>,
}
impl Snapshot {
    fn wire(self) -> Result<Response, String> {
        let header = serde_json::to_vec(&self.header).map_err(|e| e.to_string())?;
        let len = u32::try_from(header.len()).map_err(|_| "Clipboard response is too large")?;
        let mut out = Vec::with_capacity(4 + header.len() + self.png.len());
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&header);
        out.extend_from_slice(&self.png);
        Ok(Response::new(out))
    }
}
fn unchanged(start: &str, current: String) -> Result<(), String> {
    if start == current {
        Ok(())
    } else {
        Err(CHANGED.into())
    }
}
#[cfg(any(target_os = "macos", windows, test))]
fn capture(
    start: String,
    revision: impl Fn() -> Result<String, String>,
    known: Option<&str>,
    image: ImageRequest,
    text: impl FnOnce() -> Result<String, String>,
    pixels: impl FnOnce() -> Result<Option<Vec<u8>>, String>,
) -> Result<Snapshot, String> {
    unchanged(&start, revision()?)?;
    let text = text()?;
    unchanged(&start, revision()?)?;
    let (status, png) = if !image.wanted(&text, false) {
        (ImageStatus::Omitted, Vec::new())
    } else if known == Some(start.as_str()) {
        (ImageStatus::Reuse, Vec::new())
    } else {
        match pixels()? {
            Some(png) => (ImageStatus::Png, png),
            None => (ImageStatus::Empty, Vec::new()),
        }
    };
    unchanged(&start, revision()?)?;
    Ok(Snapshot {
        header: Header {
            revision: start,
            text: Some(text),
            image: status,
            focus_required: false,
        },
        png,
    })
}
fn encode_image(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    if width == 0
        || height == 0
        || width > 16_384
        || height > 16_384
        || u64::from(width) * u64::from(height) * 4 > 512 * 1024 * 1024
    {
        return Err("Clipboard image is too large or invalid".into());
    }
    super::clipboard_image::encode_png(rgba, width, height)
}
#[cfg(any(target_os = "linux", test))]
fn packed_rgba(
    bytes: &[u8],
    width: usize,
    height: usize,
    stride: usize,
    channels: usize,
) -> Result<Vec<u8>, String> {
    if width == 0
        || height == 0
        || width > 16_384
        || height > 16_384
        || width * height * 4 > 512 * 1024 * 1024
        || ![3, 4].contains(&channels)
        || stride < width * channels
        || stride
            .checked_mul(height - 1)
            .and_then(|n| n.checked_add(width * channels))
            .is_none_or(|n| n > bytes.len())
    {
        return Err("Clipboard image pixels are incomplete or too large".into());
    }
    let mut rgba = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        for pixel in bytes[y * stride..y * stride + width * channels].chunks_exact(channels) {
            rgba.extend_from_slice(&pixel[..3]);
            rgba.push(if channels == 4 { pixel[3] } else { 255 });
        }
    }
    Ok(rgba)
}
#[cfg(target_os = "macos")]
fn revision() -> Result<String, String> {
    Ok(objc2_app_kit::NSPasteboard::generalPasteboard()
        .changeCount()
        .to_string())
}
#[cfg(windows)]
fn revision() -> Result<String, String> {
    let value = unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() };
    if value == 0 {
        return Err("Clipboard version is unavailable. Copy again and retry Paste.".into());
    }
    Ok(value.to_string())
}

#[tauri::command]
pub async fn terminal_clipboard_snapshot(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    page_generation: String,
    primary: bool,
    image: ImageRequest,
    known_image_revision: Option<String>,
) -> Result<Response, String> {
    let label = window.label().to_owned();
    app.state::<NetworkPages>()
        .with_page(&label, &page_generation, || Ok(()))?;
    #[cfg(any(target_os = "macos", windows))]
    {
        if primary {
            return Snapshot {
                header: Header {
                    revision: "unsupported".into(),
                    text: None,
                    image: ImageStatus::Omitted,
                    focus_required: false,
                },
                png: Vec::new(),
            }
            .wire();
        }
        let start = revision()?;
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<NetworkPages>()
                .with_page(&label, &page_generation, || Ok(()))?;
            // Use the already-bundled arboard API directly so absence stays
            // distinct from an OS error (the plugin erases that distinction).
            let clipboard =
                std::cell::RefCell::new(arboard::Clipboard::new().map_err(|e| e.to_string())?);
            let snapshot = capture(
                start,
                revision,
                known_image_revision.as_deref(),
                image,
                || match clipboard.borrow_mut().get_text() {
                    Ok(text) => Ok(text),
                    Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
                    Err(e) => Err(e.to_string()),
                },
                || match clipboard.borrow_mut().get_image() {
                    Ok(image) => encode_image(
                        &image.bytes,
                        image.width.try_into().map_err(|_| "Invalid image width")?,
                        image
                            .height
                            .try_into()
                            .map_err(|_| "Invalid image height")?,
                    )
                    .map(Some),
                    Err(arboard::Error::ContentNotAvailable) => Ok(None),
                    Err(e) => Err(e.to_string()),
                },
            )?;
            app.state::<NetworkPages>()
                .with_page(&label, &page_generation, || Ok(()))?;
            snapshot.wire()
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(target_os = "linux")]
    {
        let snapshot = linux::capture(
            &app,
            &label,
            &page_generation,
            primary,
            image,
            known_image_revision,
        )
        .await?;
        app.state::<NetworkPages>()
            .with_page(&label, &page_generation, || Ok(()))?;
        snapshot.wire()
    }
}

#[cfg(any(target_os = "linux", test))]
mod focus;
#[cfg(target_os = "linux")]
mod linux;

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn pixels_preserve_alpha_and_strip_row_padding_with_checked_bounds() {
        assert_eq!(
            packed_rgba(&[1, 2, 3, 99, 4, 5, 6], 1, 2, 4, 3).unwrap(),
            [1, 2, 3, 255, 4, 5, 6, 255]
        );
        assert_eq!(
            packed_rgba(&[1, 2, 3, 4], 1, 1, 4, 4).unwrap(),
            [1, 2, 3, 4]
        );
        assert!(packed_rgba(&[], 1, 2, usize::MAX, 4).is_err());
        assert!(packed_rgba(&[1, 2], 1, 1, 3, 3).is_err());
        assert!(packed_rgba(&[], 16_385, 1, 4, 4).is_err());
    }
    #[test]
    fn changes_before_and_during_capture_never_return_mixed_contents() {
        let rev = Cell::new(1);
        let current = || Ok(rev.get().to_string());
        assert!(capture(
            "0".into(),
            current,
            None,
            ImageRequest::Always,
            || panic!(),
            || panic!()
        )
        .is_err());
        assert!(capture(
            "1".into(),
            current,
            None,
            ImageRequest::Always,
            || {
                rev.set(2);
                Ok("old text".into())
            },
            || panic!("new image must not be read")
        )
        .is_err());
        assert!(capture(
            "2".into(),
            current,
            None,
            ImageRequest::Always,
            || Ok("text".into()),
            || {
                rev.set(3);
                Ok(Some(vec![1]))
            }
        )
        .is_err());
    }
    #[test]
    fn reuse_requires_current_version_and_matching_request() {
        let reused = capture(
            "1".into(),
            || Ok("1".into()),
            Some("1"),
            ImageRequest::Always,
            || Ok("text".into()),
            || panic!("reuse must not encode"),
        )
        .unwrap();
        assert!(matches!(reused.header.image, ImageStatus::Reuse));
        let replaced = capture(
            "2".into(),
            || Ok("2".into()),
            Some("1"),
            ImageRequest::Always,
            || Ok("new text".into()),
            || Ok(None),
        )
        .unwrap();
        assert!(matches!(replaced.header.image, ImageStatus::Empty));
        let text = capture(
            "2".into(),
            || Ok("2".into()),
            None,
            ImageRequest::IfEmpty,
            || Ok("text".into()),
            || panic!("text paste must not encode image"),
        )
        .unwrap();
        assert!(matches!(text.header.image, ImageStatus::Omitted));
        assert!(capture(
            "2".into(),
            || Err("unavailable".into()),
            Some("2"),
            ImageRequest::Always,
            || panic!(),
            || panic!()
        )
        .is_err());
    }
}
