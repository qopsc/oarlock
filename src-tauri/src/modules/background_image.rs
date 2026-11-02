//! Inspect background images before the webview allocates decoded pixels.
mod platform;

use platform::inspect;
#[cfg(all(test, target_os = "linux"))]
use platform::png_is_animated;
use std::sync::{Arc, OnceLock};
use tauri::{ipc::Request, Manager};
use tokio::sync::Semaphore;

use super::{ipc_body, net::page::NetworkPages};

const MAX_ENCODED: usize = 30 * 1024 * 1024;
const MAX_JSON_FALLBACK: usize = 2 * 1024 * 1024;
const MAX_TOTAL_PIXELS: u64 = 64 * 1024 * 1024;
const MAX_FRAMES: u64 = 1024;

fn encoded_canvas(bytes: &[u8]) -> Option<(u64, u64)> {
    if bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") && &bytes[12..16] == b"IHDR" {
        return Some((
            u32::from_be_bytes(bytes[16..20].try_into().ok()?) as u64,
            u32::from_be_bytes(bytes[20..24].try_into().ok()?) as u64,
        ));
    }
    if bytes.len() >= 10 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        return Some((
            u16::from_le_bytes([bytes[6], bytes[7]]) as u64,
            u16::from_le_bytes([bytes[8], bytes[9]]) as u64,
        ));
    }
    if bytes.len() >= 30 && bytes.starts_with(b"RIFF") && &bytes[8..16] == b"WEBPVP8X" {
        let number = |start: usize| {
            u32::from_le_bytes([bytes[start], bytes[start + 1], bytes[start + 2], 0]) as u64 + 1
        };
        return Some((number(24), number(27)));
    }
    if bytes.len() >= 30
        && bytes.starts_with(b"RIFF")
        && &bytes[8..16] == b"WEBPVP8 "
        && &bytes[23..26] == b"\x9d\x01\x2a"
    {
        let width = u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3fff;
        let height = u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3fff;
        return Some((width as u64, height as u64));
    }
    if bytes.len() >= 25
        && bytes.starts_with(b"RIFF")
        && &bytes[8..16] == b"WEBPVP8L"
        && bytes[20] == 0x2f
    {
        let bits = u32::from_le_bytes(bytes[21..25].try_into().ok()?);
        return Some((
            (bits & 0x3fff) as u64 + 1,
            ((bits >> 14) & 0x3fff) as u64 + 1,
        ));
    }
    None
}

fn webp_canvas(bytes: &[u8]) -> Result<Option<(u64, u64)>, String> {
    if bytes.len() < 12 || !bytes.starts_with(b"RIFF") || &bytes[8..12] != b"WEBP" {
        return Ok(None);
    }
    let mut offset = 12usize;
    let mut largest = (0, 0);
    let mut chunks = 0usize;
    while let Some(header) = bytes.get(offset..offset.saturating_add(8)) {
        chunks += 1;
        if chunks > 4096 {
            return Err("WebP metadata is too complex".into());
        }
        let length = u32::from_le_bytes(
            header[4..8]
                .try_into()
                .map_err(|_| "Invalid WebP metadata")?,
        ) as usize;
        let end = offset
            .checked_add(8)
            .and_then(|start| start.checked_add(length))
            .ok_or("Invalid WebP metadata")?;
        if end > bytes.len() {
            return Err("Invalid WebP metadata".into());
        }
        let payload = &bytes[offset + 8..end];
        let size = if &header[..4] == b"VP8X" && payload.len() >= 10 {
            let number = |start: usize| {
                u32::from_le_bytes([payload[start], payload[start + 1], payload[start + 2], 0])
                    as u64
                    + 1
            };
            Some((number(4), number(7)))
        } else if &header[..4] == b"VP8 "
            && payload.len() >= 10
            && &payload[3..6] == b"\x9d\x01\x2a"
        {
            Some((
                (u16::from_le_bytes([payload[6], payload[7]]) & 0x3fff) as u64,
                (u16::from_le_bytes([payload[8], payload[9]]) & 0x3fff) as u64,
            ))
        } else if &header[..4] == b"VP8L" && payload.len() >= 5 && payload[0] == 0x2f {
            let bits =
                u32::from_le_bytes(payload[1..5].try_into().map_err(|_| "Invalid WebP frame")?);
            Some((
                (bits & 0x3fff) as u64 + 1,
                ((bits >> 14) & 0x3fff) as u64 + 1,
            ))
        } else {
            None
        };
        if let Some((width, height)) = size {
            largest.0 = largest.0.max(width);
            largest.1 = largest.1.max(height);
        }
        offset = end.checked_add(length % 2).ok_or("Invalid WebP metadata")?;
    }
    if largest.0 == 0 || largest.1 == 0 {
        return Err("WebP dimensions are unavailable".into());
    }
    Ok(Some(largest))
}

// JPEG stores its frame dimensions before the first scan. Reject malformed
// headers rather than asking an image decoder to discover their size.
fn jpeg_canvas(bytes: &[u8]) -> Result<Option<(u64, u64)>, String> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return Ok(None);
    }
    let mut offset = 2usize;
    let mut dimensions: Option<(u64, u64)> = None;
    let mut segments = 0usize;
    while offset < bytes.len() {
        segments += 1;
        if segments > 4096 {
            return Err("JPEG metadata is too complex".into());
        }
        if bytes[offset] != 0xff {
            return Err("Invalid JPEG metadata".into());
        }
        while bytes.get(offset) == Some(&0xff) {
            offset += 1;
        }
        let marker = *bytes.get(offset).ok_or("Invalid JPEG metadata")?;
        offset += 1;
        if marker == 0xda {
            return dimensions
                .map(Some)
                .ok_or_else(|| "JPEG dimensions are unavailable".into());
        }
        if marker == 0xd9 || marker == 0xd8 || marker == 0x00 {
            return Err("Invalid JPEG metadata".into());
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let length = u16::from_be_bytes(
            bytes
                .get(offset..offset + 2)
                .ok_or("Invalid JPEG metadata")?
                .try_into()
                .map_err(|_| "Invalid JPEG metadata")?,
        ) as usize;
        if length < 2 {
            return Err("Invalid JPEG metadata".into());
        }
        let end = offset.checked_add(length).ok_or("Invalid JPEG metadata")?;
        if end > bytes.len() {
            return Err("Invalid JPEG metadata".into());
        }
        if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
            if length < 8 {
                return Err("Invalid JPEG frame".into());
            }
            let height = u16::from_be_bytes([bytes[offset + 3], bytes[offset + 4]]) as u64;
            let width = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]) as u64;
            let (old_width, old_height) = dimensions.unwrap_or((0, 0));
            dimensions = Some((old_width.max(width), old_height.max(height)));
        }
        offset = end;
    }
    Err("JPEG dimensions are unavailable".into())
}

fn validate(width: u64, height: u64, frames: u64) -> Result<(), String> {
    if width == 0 || height == 0 || frames == 0 || frames > MAX_FRAMES {
        return Err("Image dimensions or frame count are unavailable".into());
    }
    if width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(frames))
        .is_none_or(|pixels| pixels > MAX_TOTAL_PIXELS)
    {
        return Err("Image dimensions or animation exceed the decoded image limit".into());
    }
    Ok(())
}

fn inspect_checked(bytes: &[u8]) -> Result<(), String> {
    let webp = webp_canvas(bytes)?;
    let canvas = webp.or(encoded_canvas(bytes)).or(jpeg_canvas(bytes)?);
    if bytes.len() >= 12
        && bytes.starts_with(b"RIFF")
        && &bytes[8..12] == b"WEBP"
        && canvas.is_none()
    {
        return Err("WebP dimensions are unavailable".into());
    }
    if let Some((width, height)) = canvas {
        validate(width, height, 1)?;
    }
    let (width, height, frames) = inspect(bytes)?;
    validate(width, height, frames)
}

fn budget() -> &'static Arc<Semaphore> {
    static BUDGET: OnceLock<Arc<Semaphore>> = OnceLock::new();
    BUDGET.get_or_init(|| Arc::new(Semaphore::new(2)))
}

fn waiters() -> &'static Arc<Semaphore> {
    static WAITERS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    WAITERS.get_or_init(|| Arc::new(Semaphore::new(16)))
}

#[tauri::command]
pub async fn background_image_inspect(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Request<'_>,
) -> Result<(), String> {
    let page = request
        .headers()
        .get("x-page-generation")
        .and_then(|value| value.to_str().ok())
        .ok_or("Missing image inspection ownership")?
        .to_owned();
    let label = window.label().to_owned();
    app.state::<NetworkPages>()
        .with_page(&label, &page, || Ok(()))?;
    let waiter = waiters()
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Image inspection is busy. Try again.")?;
    let permit = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        budget().clone().acquire_owned(),
    )
    .await
    .map_err(|_| "Image inspection is busy. Try again.")?
    .map_err(|_| "Image inspection is unavailable")?;
    drop(waiter);
    app.state::<NetworkPages>()
        .with_page(&label, &page, || Ok(()))?;
    let bytes = ipc_body::bytes_of(request.body(), MAX_ENCODED, MAX_JSON_FALLBACK)?.into_owned();
    let task = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        app.state::<NetworkPages>()
            .with_page(&label, &page, || Ok(()))?;
        inspect_checked(&bytes)
    });
    match tokio::time::timeout(std::time::Duration::from_secs(15), task).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("Image inspection timed out. Try a different image.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pixel_and_frame_products_are_checked_before_decode() {
        assert!(validate(8192, 8192, 1).is_ok());
        assert!(validate(8193, 8192, 1).is_err());
        assert!(validate(4096, 4096, 5).is_err());
        assert!(validate(u64::MAX, 2, 1).is_err());
        assert!(validate(0, 1, 1).is_err());
    }
    #[test]
    fn jpeg_header_is_checked_before_calling_a_platform_decoder() {
        let jpeg = [0xff,0xd8,0xff,0xc0,0,11,8,0x20,1,0x20,1,1,1,0x11,0,0xff,0xda];
        let (width, height) = jpeg_canvas(&jpeg).unwrap().unwrap();
        assert_eq!((width, height), (8193, 8193));
        assert!(validate(width, height, 1).is_err());
        assert!(inspect_checked(&jpeg).unwrap_err().contains("decoded image limit"));
        assert!(jpeg_canvas(&jpeg[..8]).is_err());
    }
    #[test]
    fn webp_checks_both_canvas_and_encoded_frame_before_decode() {
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0".to_vec();
        webp.extend_from_slice(&[0,0,0,0,9,0,0,9,0,0]);
        webp.extend_from_slice(b"VP8 \x0a\0\0\0");
        webp.extend_from_slice(&[0,0,0,0x9d,1,0x2a,1,0x20,1,0x20]);
        assert_eq!(webp_canvas(&webp).unwrap(), Some((8193, 8193)));
        assert!(inspect_checked(&webp).unwrap_err().contains("decoded image limit"));
    }
    #[test]
    fn excessive_metadata_segments_are_refused() {
        let mut jpeg = vec![0xff, 0xd8];
        for _ in 0..4097 { jpeg.extend_from_slice(&[0xff, 0xe0, 0, 2]); }
        assert!(jpeg_canvas(&jpeg).unwrap_err().contains("too complex"));
        let mut webp = b"RIFF\0\0\0\0WEBP".to_vec();
        for _ in 0..4097 { webp.extend_from_slice(b"JUNK\0\0\0\0"); }
        assert!(webp_canvas(&webp).unwrap_err().contains("too complex"));
        #[cfg(target_os = "linux")]
        {
            let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
            for _ in 0..1025 { png.extend_from_slice(b"\0\0\0\0tEXt\0\0\0\0"); }
            assert!(png_is_animated(&png).unwrap_err().contains("too complex"));
        }
    }
    #[tokio::test]
    async fn image_work_and_waiters_are_bounded_and_resume_after_release() {
        let first = budget().clone().acquire_owned().await.unwrap();
        let second = budget().clone().acquire_owned().await.unwrap();
        assert!(budget().clone().try_acquire_owned().is_err());
        let queued: Vec<_> = (0..16).map(|_| waiters().clone().try_acquire_owned().unwrap()).collect();
        assert!(waiters().clone().try_acquire_owned().is_err());
        let next = budget().clone().acquire_owned();
        drop(first);
        let third = tokio::time::timeout(std::time::Duration::from_secs(1), next).await.unwrap().unwrap();
        drop((second, third, queued));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_refuses_animated_images_without_confusing_png_payload_bytes() {
        let gif = [71,73,70,56,57,97,10,0,10,0,128,0,0,0,0,0,255,255,255,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59];
        assert!(inspect(&gif).unwrap_err().contains("Animated"));
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\x04IDATacTL\0\0\0\0";
        assert!(!png_is_animated(png).unwrap());
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn real_png_dimensions_are_read_before_image_decode() {
        let png = [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,2,0,0,0,144,119,83,222,0,0,0,12,73,68,65,84,120,156,99,96,96,96,0,0,0,4,0,1,246,23,56,85,0,0,0,0,73,69,78,68,174,66,96,130];
        assert_eq!(inspect(&png).unwrap(), (1, 1, 1));
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn real_jpeg_survives_both_header_and_platform_inspection() {
        let jpeg = include_bytes!("../../tests/fixtures/background-tiny.jpg");
        assert_eq!(jpeg_canvas(jpeg).unwrap(), Some((1, 1)));
        assert!(inspect_checked(jpeg).is_ok());
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn real_lossy_and_lossless_webp_survive_inspection() {
        for webp in [
            include_bytes!("../../tests/fixtures/background-tiny-lossy.webp").as_slice(),
            include_bytes!("../../tests/fixtures/background-tiny-lossless.webp").as_slice(),
        ] {
            assert_eq!(webp_canvas(webp).unwrap(), Some((1, 1)));
            assert!(inspect_checked(webp).is_ok());
        }
    }
    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn real_apng_is_counted_or_refused_by_platform_policy() {
        let apng = include_bytes!("../../tests/fixtures/background-tiny.apng");
        #[cfg(target_os = "macos")]
        assert_eq!(inspect(apng).unwrap(), (1, 1, 2));
        #[cfg(target_os = "linux")]
        assert!(inspect(apng).unwrap_err().contains("Animated"));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn gif_logical_canvas_is_not_confused_with_its_smaller_frame() {
        let gif = [71,73,70,56,57,97,10,0,10,0,128,0,0,0,0,0,255,255,255,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59];
        assert_eq!(inspect(&gif).unwrap(), (10, 10, 1));
    }
}
