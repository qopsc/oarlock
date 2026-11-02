//! Clipboard images for terminal programs (the Kitty clipboard protocol),
//! through the clipboard plugin's long-lived clipboard, so
//! images stay served on X11. Version-checked reads live in clipboard_read.

use std::io::{self, Cursor, Write};

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
    let mut out = BoundedPng::new(MAX_PNG_BYTES);
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive)
        .write_image(rgba, width, height, ExtendedColorType::Rgba8)
        .map_err(|error| error.to_string())?;
    Ok(out.bytes)
}

struct BoundedPng {
    bytes: Vec<u8>,
    limit: usize,
}
impl BoundedPng {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
        }
    }
}
impl Write for BoundedPng {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(io::Error::other("the clipboard image is too large"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Check dimensions from the image header before decoding or allocating RGBA pixels.
fn decode_image(
    data: &[u8],
    mime: &str,
    max_decoded_bytes: u64,
) -> Result<(Vec<u8>, u32, u32), ClipboardImageWriteError> {
    let format = match mime.to_ascii_lowercase().as_str() {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/gif" => ImageFormat::Gif,
        "image/webp" => ImageFormat::WebP,
        _ => {
            return Err(ClipboardImageWriteError::policy(
                "image-unsupported",
                "Unsupported clipboard image format. Use PNG, JPEG, GIF, or WebP.",
            ))
        }
    };
    if image::guess_format(data).ok() != Some(format) {
        return Err(ClipboardImageWriteError::decode(
            "Clipboard image does not match its declared format",
        ));
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(max_decoded_bytes);
    let mut header = ImageReader::with_format(Cursor::new(data), format);
    header.limits(limits.clone());
    let (width, height) = header.into_dimensions().map_err(|error| {
        if matches!(error, image::ImageError::Limits(_)) {
            ClipboardImageWriteError::policy("image-limit", "Clipboard image is too large.")
        } else {
            ClipboardImageWriteError::decode(error)
        }
    })?;
    if u64::from(width) * u64::from(height) * 4 > max_decoded_bytes {
        return Err(ClipboardImageWriteError::policy(
            "image-limit",
            "Clipboard image is too large.",
        ));
    }
    let mut reader = ImageReader::with_format(Cursor::new(data), format);
    reader.limits(limits);
    let image = reader.decode().map_err(|error| {
        if matches!(error, image::ImageError::Limits(_)) {
            ClipboardImageWriteError::policy("image-limit", "Clipboard image is too large.")
        } else {
            ClipboardImageWriteError::decode(error)
        }
    })?;
    let (width, height) = (image.width(), image.height());
    Ok((image.into_rgba8().into_raw(), width, height))
}

/// Decode failures permit the terminal's text alternative; OS failures do not.
#[derive(Debug, serde::Serialize)]
pub struct ClipboardImageWriteError {
    code: &'static str,
    message: String,
}

impl ClipboardImageWriteError {
    fn policy(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
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

/// Body: a supported image, which replaces the clipboard's contents.
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
    let mime = request
        .headers()
        .get("x-clipboard-image-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_owned();
    let label = window.label().to_owned();
    app.state::<NetworkPages>()
        .with_page(&label, &page, || {
            app.state::<ClipboardWrites>()
                .check(&label, &page, &ticket, false)
        })
        .map_err(ClipboardImageWriteError::write)?;
    let permit = super::clipboard_work::budget()
        .image()
        .map_err(ClipboardImageWriteError::write)?;
    let data = ipc_body::bytes_of(request.body(), MAX_PNG_BYTES, 0)
        .map_err(|error| {
            if error.contains("exceeds") || error.contains("too large") {
                ClipboardImageWriteError::policy("image-limit", "Clipboard image is too large.")
            } else {
                ClipboardImageWriteError::decode(error)
            }
        })?
        .into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        app.state::<NetworkPages>()
            .with_page(&label, &page, || {
                app.state::<ClipboardWrites>()
                    .check(&label, &page, &ticket, false)
            })
            .map_err(ClipboardImageWriteError::write)?;
        let (rgba, width, height) = decode_image(&data, &mime, MAX_DECODED_BYTES)?;
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
    fn png_output_never_grows_past_its_budget() {
        let mut output = BoundedPng::new(4);
        output.write_all(b"1234").unwrap();
        assert!(output.write_all(b"5").is_err());
        assert_eq!(output.bytes, b"1234");
    }

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
        let error = decode_image(&png, "image/png", 1024 * 1024).unwrap_err();
        assert_eq!(error.code, "image-limit");
    }

    #[test]
    fn images_round_trip_through_png() {
        let rgba: Vec<u8> = (0..4 * 3 * 2).map(|i| (i * 7) as u8).collect();
        let png = encode_png(&rgba, 3, 2).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(
            decode_image(&png, "image/png", MAX_DECODED_BYTES).unwrap(),
            (rgba, 3, 2)
        );
    }

    #[test]
    fn writes_refuse_what_is_not_a_reasonable_png() {
        assert!(decode_image(b"not a png", "image/png", MAX_DECODED_BYTES).is_err());
        // A header claiming an image wider than the limit is refused before
        // any pixels are allocated.
        let wide = encode_png(&[0; 4], 1, 1).unwrap();
        let mut forged = wide.clone();
        // IHDR width (bytes 16..20), big-endian; the CRC no longer matches,
        // which the decoder may report first: either way it is refused.
        forged[16..20].copy_from_slice(&(MAX_SIDE + 1).to_be_bytes());
        assert!(decode_image(&forged, "image/png", MAX_DECODED_BYTES).is_err());
    }

    #[test]
    fn supported_formats_decode_and_gif_uses_its_first_frame() {
        use image::{DynamicImage, Frame, ImageBuffer, Rgba};
        let red = ImageBuffer::from_pixel(3, 2, Rgba([255, 0, 0, 255]));
        for (format, mime) in [
            (ImageFormat::Png, "image/png"),
            (ImageFormat::Jpeg, "image/jpeg"),
            (ImageFormat::WebP, "image/webp"),
        ] {
            let mut encoded = Cursor::new(Vec::new());
            DynamicImage::ImageRgba8(red.clone())
                .write_to(&mut encoded, format)
                .unwrap();
            let (pixels, width, height) =
                decode_image(encoded.get_ref(), mime, MAX_DECODED_BYTES).unwrap();
            assert_eq!((width, height), (3, 2));
            assert!(
                pixels[0] > 200 && pixels[1] < 30 && pixels[2] < 30,
                "{mime}"
            );
        }
        let mut bytes = Vec::new();
        {
            let mut gif = image::codecs::gif::GifEncoder::new(&mut bytes);
            gif.encode_frame(Frame::new(red)).unwrap();
            gif.encode_frame(Frame::new(ImageBuffer::from_pixel(
                3,
                2,
                Rgba([0, 0, 255, 255]),
            )))
            .unwrap();
        }
        let (pixels, width, height) = decode_image(&bytes, "image/gif", MAX_DECODED_BYTES).unwrap();
        assert_eq!((width, height), (3, 2));
        assert!(pixels[0] > 200 && pixels[2] < 30);
    }

    #[test]
    fn oversized_headers_and_unsupported_formats_are_policy_errors() {
        let wide = encode_png(&vec![0; (MAX_SIDE as usize + 1) * 4], MAX_SIDE + 1, 1).unwrap();
        assert_eq!(
            decode_image(&wide, "image/png", MAX_DECODED_BYTES)
                .unwrap_err()
                .code,
            "image-limit"
        );
        assert_eq!(
            decode_image(&wide, "image/svg+xml", MAX_DECODED_BYTES)
                .unwrap_err()
                .code,
            "image-unsupported"
        );
        assert_eq!(
            decode_image(&wide, "image/jpeg", MAX_DECODED_BYTES)
                .unwrap_err()
                .code,
            "image-decode"
        );
    }
}
