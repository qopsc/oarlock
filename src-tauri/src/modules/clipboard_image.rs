//! Clipboard images for terminal programs (the Kitty clipboard protocol),
//! as PNG writes through the clipboard plugin's long-lived clipboard, so
//! images stay served on X11. Version-checked reads live in clipboard_read.

use std::io::Cursor;

use super::{clipboard_write::ClipboardWrites, net::page::NetworkPages};
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, ImageFormat, ImageReader, Limits};
use tauri::ipc::Request;
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;

use super::ipc_body;

/// PNG bytes taken or given at once: as much as one Kitty clipboard write
/// carries. Reads larger than a Kitty answer serves are refused by the
/// webview (`terminalIntegration.ts`).
const MAX_PNG_BYTES: usize = 64 * 1024 * 1024;
/// Largest side of an image written, against decompression bombs.
const MAX_SIDE: u32 = 16_384;
/// Decoded bytes an image written may take.
const MAX_DECODED_BYTES: u64 = 512 * 1024 * 1024;

/// RGBA pixels as PNG, compressed for speed: the program receiving it
/// recompresses if it cares.
pub(super) fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive)
        .write_image(rgba, width, height, ExtendedColorType::Rgba8)
        .map_err(|error| error.to_string())?;
    if out.len() > MAX_PNG_BYTES {
        return Err("the clipboard image is too large".into());
    }
    Ok(out)
}

/// A PNG as RGBA pixels, refusing images too large to hold.
fn decode_png(png: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    decode_png_limited(png, MAX_DECODED_BYTES)
}

fn decode_png_limited(png: &[u8], max_decoded_bytes: u64) -> Result<(Vec<u8>, u32, u32), String> {
    let mut reader = ImageReader::with_format(Cursor::new(png), ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(max_decoded_bytes);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| format!("not a usable PNG: {error}"))?;
    let (width, height) = (image.width(), image.height());
    if u64::from(width) * u64::from(height) * 4 > max_decoded_bytes {
        return Err("expanded clipboard image is too large".into());
    }
    Ok((image.into_rgba8().into_raw(), width, height))
}

/// Decode failures permit the terminal's text alternative; OS failures do not.
#[derive(Debug, serde::Serialize)]
pub struct ClipboardImageWriteError {
    code: &'static str,
    message: String,
}

impl ClipboardImageWriteError {
    fn decode(message: impl ToString) -> Self {
        Self {
            code: "image-decode",
            message: message.to_string(),
        }
    }

    fn write(message: impl ToString) -> Self {
        Self {
            code: "clipboard-write",
            message: message.to_string(),
        }
    }
}

/// Body: a PNG, which replaces the clipboard's contents.
#[tauri::command]
pub async fn clipboard_image_write(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Request<'_>,
) -> Result<(), ClipboardImageWriteError> {
    let header = |name| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| ClipboardImageWriteError::write("Missing clipboard write ownership"))
    };
    let page = header("x-page-generation")?;
    let ticket = header("x-clipboard-ticket")?;
    let label = window.label().to_owned();
    app.state::<NetworkPages>()
        .with_page(&label, &page, || {
            app.state::<ClipboardWrites>()
                .check(&label, &page, &ticket, false)
        })
        .map_err(ClipboardImageWriteError::write)?;
    let png = ipc_body::bytes_of(request.body(), MAX_PNG_BYTES, 0)
        .map_err(ClipboardImageWriteError::decode)?
        .into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let (rgba, width, height) = decode_png(&png).map_err(ClipboardImageWriteError::decode)?;
        let image = tauri::image::Image::new_owned(rgba, width, height);
        app.state::<ClipboardWrites>()
            .commit(
                &app.state::<NetworkPages>(),
                &label,
                &page,
                &ticket,
                false,
                || {
                    app.clipboard()
                        .write_image(&image)
                        .map_err(|e| e.to_string())
                },
            )
            .map_err(ClipboardImageWriteError::write)
    })
    .await
    .map_err(ClipboardImageWriteError::write)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_failures_are_distinct_from_native_commit_failures() {
        assert_eq!(
            serde_json::to_value(ClipboardImageWriteError::decode("bad PNG")).unwrap(),
            serde_json::json!({"code": "image-decode", "message": "bad PNG"})
        );
        assert_eq!(
            serde_json::to_value(ClipboardImageWriteError::write("clipboard busy")).unwrap(),
            serde_json::json!({"code": "clipboard-write", "message": "clipboard busy"})
        );
    }

    #[test]
    fn grayscale_expansion_must_fit_the_rgba_budget() {
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&vec![0; 1024 * 512], 1024, 512, ExtendedColorType::L8)
            .unwrap();
        // The source grayscale pixels fit in 1 MiB; their RGBA expansion does not.
        let result = decode_png_limited(&png, 1024 * 1024);
        assert_eq!(result.unwrap_err(), "expanded clipboard image is too large");
    }

    #[test]
    fn images_round_trip_through_png() {
        let rgba: Vec<u8> = (0..4 * 3 * 2).map(|i| (i * 7) as u8).collect();
        let png = encode_png(&rgba, 3, 2).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(decode_png(&png).unwrap(), (rgba, 3, 2));
    }

    #[test]
    fn writes_refuse_what_is_not_a_reasonable_png() {
        assert!(decode_png(b"not a png").is_err());
        // A header claiming an image wider than the limit is refused before
        // any pixels are allocated.
        let wide = encode_png(&[0; 4], 1, 1).unwrap();
        let mut forged = wide.clone();
        // IHDR width (bytes 16..20), big-endian; the CRC no longer matches,
        // which the decoder may report first: either way it is refused.
        forged[16..20].copy_from_slice(&(MAX_SIDE + 1).to_be_bytes());
        assert!(decode_png(&forged).is_err());
    }
}
