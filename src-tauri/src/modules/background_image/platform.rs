//! Platform-specific metadata inspection, kept separate from admission and limits.
#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::encoded_canvas;
#[cfg(target_os = "linux")]
use super::webp_canvas;
#[cfg(target_os = "macos")]
use super::{validate, MAX_FRAMES};

#[cfg(target_os = "macos")]
pub(super) fn inspect(bytes: &[u8]) -> Result<(u64, u64, u64), String> {
    use std::ffi::c_void;
    use std::ptr;
    #[link(name = "ImageIO", kind = "framework")]
    extern "C" {
        fn CGImageSourceCreateWithData(
            data: *const c_void,
            options: *const c_void,
        ) -> *const c_void;
        fn CGImageSourceCopyPropertiesAtIndex(
            source: *const c_void,
            index: usize,
            options: *const c_void,
        ) -> *const c_void;
        fn CGImageSourceGetCount(source: *const c_void) -> usize;
        static kCGImagePropertyPixelWidth: *const c_void;
        static kCGImagePropertyPixelHeight: *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFDataCreate(allocator: *const c_void, bytes: *const u8, length: isize)
            -> *const c_void;
        fn CFDictionaryGetValue(dictionary: *const c_void, key: *const c_void) -> *const c_void;
        fn CFGetTypeID(value: *const c_void) -> usize;
        fn CFNumberGetTypeID() -> usize;
        fn CFNumberGetValue(number: *const c_void, kind: isize, output: *mut c_void) -> u8;
        fn CFRelease(value: *const c_void);
    }
    struct Owned(*const c_void);
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) }
        }
    }
    fn owned(value: *const c_void) -> Result<Owned, String> {
        if value.is_null() {
            Err("Image metadata is unavailable or unsupported".into())
        } else {
            Ok(Owned(value))
        }
    }
    unsafe fn number(properties: *const c_void, key: *const c_void) -> Result<u64, String> {
        let value = CFDictionaryGetValue(properties, key);
        if value.is_null() || CFGetTypeID(value) != CFNumberGetTypeID() {
            return Err("Image dimensions are unavailable".into());
        }
        let mut number: i64 = 0;
        if CFNumberGetValue(value, 4, (&mut number as *mut i64).cast()) == 0 || number <= 0 {
            return Err("Invalid image dimensions".into());
        }
        Ok(number as u64)
    }
    unsafe {
        let data = owned(CFDataCreate(
            ptr::null(),
            bytes.as_ptr(),
            bytes.len() as isize,
        ))?;
        let source = owned(CGImageSourceCreateWithData(data.0, ptr::null()))?;
        let count = CGImageSourceGetCount(source.0) as u64;
        if count == 0 || count > MAX_FRAMES {
            return Err("Image frame count exceeds the limit".into());
        }
        // An animated frame may be only a patch of a much larger canvas.
        let (mut width, mut height) = encoded_canvas(bytes).unwrap_or((0, 0));
        for index in 0..count {
            let properties = owned(CGImageSourceCopyPropertiesAtIndex(
                source.0,
                index as usize,
                ptr::null(),
            ))?;
            width = width.max(number(properties.0, kCGImagePropertyPixelWidth)?);
            height = height.max(number(properties.0, kCGImagePropertyPixelHeight)?);
            validate(width, height, count)?;
        }
        Ok((width, height, count))
    }
}

#[cfg(target_os = "linux")]
pub(super) fn png_is_animated(bytes: &[u8]) -> Result<bool, String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok(false);
    }
    let mut offset = 8usize;
    let mut chunks = 0usize;
    while let Some(header) = bytes.get(offset..offset.saturating_add(8)) {
        chunks += 1;
        if chunks > 1024 {
            return Err("PNG metadata is too complex".into());
        }
        let len =
            u32::from_be_bytes(header[..4].try_into().map_err(|_| "Invalid PNG chunk")?) as usize;
        let end = offset
            .checked_add(12)
            .and_then(|start| start.checked_add(len))
            .ok_or("Invalid PNG chunk")?;
        if end > bytes.len() {
            return Err("Invalid PNG chunk".into());
        }
        if &header[4..8] == b"acTL" {
            return Ok(true);
        }
        if &header[4..8] == b"IDAT" {
            return Ok(false);
        }
        offset = end;
    }
    Err("Invalid PNG metadata".into())
}

#[cfg(target_os = "linux")]
fn webp_is_animated(bytes: &[u8]) -> Result<bool, String> {
    if bytes.len() < 12 || !bytes.starts_with(b"RIFF") || &bytes[8..12] != b"WEBP" {
        return Ok(false);
    }
    let mut offset = 12usize;
    let mut chunks = 0usize;
    while let Some(header) = bytes.get(offset..offset.saturating_add(8)) {
        chunks += 1;
        if chunks > 4096 {
            return Err("WebP metadata is too complex".into());
        }
        let len =
            u32::from_le_bytes(header[4..8].try_into().map_err(|_| "Invalid WebP chunk")?) as usize;
        let end = offset
            .checked_add(8)
            .and_then(|start| start.checked_add(len))
            .ok_or("Invalid WebP chunk")?;
        if end > bytes.len() {
            return Err("Invalid WebP chunk".into());
        }
        if &header[..4] == b"ANIM" || &header[..4] == b"ANMF" {
            return Ok(true);
        }
        if &header[..4] == b"VP8X" && len >= 1 && bytes[offset + 8] & 2 != 0 {
            return Ok(true);
        }
        offset = end.checked_add(len % 2).ok_or("Invalid WebP chunk")?;
    }
    Ok(false)
}

#[cfg(target_os = "linux")]
pub(super) fn inspect(bytes: &[u8]) -> Result<(u64, u64, u64), String> {
    use gtk::gdk_pixbuf::prelude::*;
    use std::{cell::Cell, rc::Rc};
    // Linux's available image loaders do not expose frame counts before decoding.
    // Refuse animated formats rather than accepting an unbounded frame sequence.
    if bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || png_is_animated(bytes)?
        || webp_is_animated(bytes)?
    {
        return Err("Animated background images are not supported on Linux".into());
    }
    // Only formats with pixel dimensions reported before GdkPixbuf allocation.
    let format =
        image::guess_format(bytes).map_err(|_| "Image format is unavailable or unsupported")?;
    if !matches!(
        format,
        image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP
    ) {
        return Err("Only PNG, JPEG and static WebP backgrounds are supported on Linux".into());
    }
    if format == image::ImageFormat::WebP {
        let (width, height) = webp_canvas(bytes)?.ok_or("WebP dimensions are unavailable")?;
        return Ok((width, height, 1));
    }
    let dimensions = Rc::new(Cell::new(None));
    let reported = dimensions.clone();
    let loader = gtk::gdk_pixbuf::PixbufLoader::new();
    loader.connect_size_prepared(move |loader, width, height| {
        reported.set(Some((width, height)));
        loader.set_size(1, 1);
    });
    let mut write_error = None;
    for chunk in bytes.chunks(8192) {
        if let Err(error) = loader.write(chunk) {
            write_error = Some(format!("Image metadata: {error}"));
            break;
        }
        if dimensions.get().is_some() {
            break;
        }
    }
    // Small images may not be identified until the stream is closed. Closing
    // is also required when we stopped early after size-prepared.
    let closed = loader.close();
    if let Some(error) = write_error {
        return Err(error);
    }
    if dimensions.get().is_none() {
        closed.map_err(|error| format!("Image metadata: {error}"))?;
    }
    let (width, height) = dimensions.get().ok_or("Image dimensions are unavailable")?;
    if width <= 0 || height <= 0 {
        return Err("Invalid image dimensions".into());
    }
    let (canvas_width, canvas_height) = encoded_canvas(bytes).unwrap_or((0, 0));
    Ok((
        (width as u64).max(canvas_width),
        (height as u64).max(canvas_height),
        1,
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(super) fn inspect(_bytes: &[u8]) -> Result<(u64, u64, u64), String> {
    Err("Background image inspection is not supported on this platform".into())
}
