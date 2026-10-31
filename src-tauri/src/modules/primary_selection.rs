//! The PRIMARY selection behind the terminal's copy-on-select and middle-click
//! paste. Only X11 and Wayland have one: elsewhere a write is dropped and a
//! read finds nothing.

/// Selections above this are refused both ways: an IPC payload and a buffer
/// the owner serves to every requester, not something to middle-click paste.
const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub struct PrimarySelection {
    #[cfg(target_os = "linux")]
    inner: std::sync::Arc<linux::Primary>,
}

impl PrimarySelection {
    pub(crate) fn write_now(&self, text: String) -> Result<(), String> {
        check_size(text.len())?;
        if text.is_empty() {
            return Ok(());
        }
        #[cfg(target_os = "linux")]
        {
            self.inner.write(self.inner.ticket(), text)
        }
        #[cfg(not(target_os = "linux"))]
        {
            Ok(())
        }
    }
}

pub(super) fn check_size(len: usize) -> Result<(), String> {
    if len > MAX_TEXT_BYTES {
        return Err(format!(
            "selection is {len} bytes, more than the {MAX_TEXT_BYTES} byte limit"
        ));
    }
    Ok(())
}

/// Hands out write tickets in dispatch order.
#[derive(Default)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct WriteOrder(std::sync::atomic::AtomicU64);

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
impl WriteOrder {
    fn ticket(&self) -> u64 {
        self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
    }

    /// Admits `ticket` unless a newer write was admitted before it.
    fn admit(applied: &mut u64, ticket: u64) -> bool {
        if ticket <= *applied {
            return false;
        }
        *applied = ticket;
        true
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::sync::Mutex;

    use arboard::{Clipboard, Error, LinuxClipboardKind, SetExtLinux};

    use super::{check_size, WriteOrder};

    /// Both clipboards are created on first use and kept for the app's
    /// lifetime: on X11 the selection is served by arboard's background
    /// thread, which lives only while a `Clipboard` does (a Wayland
    /// data-control copy serves from its own thread until replaced). Reads
    /// use the independent version-checked GTK snapshot boundary.
    #[derive(Default)]
    pub struct Primary {
        order: WriteOrder,
        writer: Mutex<Writer>,
    }

    #[derive(Default)]
    struct Writer {
        clipboard: Option<Clipboard>,
        applied: u64,
    }

    impl Primary {
        pub fn ticket(&self) -> u64 {
            self.order.ticket()
        }

        pub fn write(&self, ticket: u64, text: String) -> Result<(), String> {
            let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
            let Writer { clipboard, applied } = &mut *writer;
            if !WriteOrder::admit(applied, ticket) {
                return Ok(());
            }
            let result = open(clipboard)?
                .set()
                .clipboard(LinuxClipboardKind::Primary)
                .text(text);
            match result {
                Ok(()) => Ok(()),
                Err(Error::ClipboardNotSupported) => {
                    log::debug!("this display has no PRIMARY selection");
                    Ok(())
                }
                Err(error) => Err(error.to_string()),
            }
        }
    }

    fn open(slot: &mut Option<Clipboard>) -> Result<&mut Clipboard, String> {
        if slot.is_none() {
            *slot = Some(Clipboard::new().map_err(|e| e.to_string())?);
        }
        Ok(slot.as_mut().expect("opened above"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_oversized_selection_is_refused_before_any_display_access() {
        let state = PrimarySelection::default();
        assert!(check_size(MAX_TEXT_BYTES).is_ok());
        let error = state.write_now("x".repeat(MAX_TEXT_BYTES + 1)).unwrap_err();
        assert!(error.contains("limit"), "{error}");
    }

    #[test]
    fn an_empty_selection_leaves_primary_alone() {
        assert_eq!(PrimarySelection::default().write_now(String::new()), Ok(()));
    }

    #[test]
    fn a_write_overtaken_by_a_newer_one_is_dropped() {
        let order = WriteOrder::default();
        let (first, second, third) = (order.ticket(), order.ticket(), order.ticket());
        let mut applied = 0;
        assert!(WriteOrder::admit(&mut applied, second));
        assert!(!WriteOrder::admit(&mut applied, first));
        assert!(WriteOrder::admit(&mut applied, third));
        assert!(!WriteOrder::admit(&mut applied, third));
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn other_platforms_have_no_primary_selection() {
        let state = PrimarySelection::default();
        assert_eq!(state.write_now("text".into()), Ok(()));
    }
}
