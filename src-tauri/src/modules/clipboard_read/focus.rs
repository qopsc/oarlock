pub(super) const FOCUS_REQUIRED: &str =
    "Clipboard reads on Wayland require this window to have keyboard focus. Focus it and try again.";

#[derive(Clone, Copy)]
pub(super) struct FocusVersion {
    epoch: u64,
    focused: bool,
    closed: bool,
}
impl FocusVersion {
    pub(super) fn new(epoch: u64, focused: bool) -> Self {
        Self {
            epoch,
            focused,
            closed: false,
        }
    }
    pub(super) fn update(&mut self, epoch: u64, focused: bool) {
        if self.focused != focused {
            self.epoch = epoch;
            self.focused = focused;
        }
    }
    pub(super) fn close(&mut self) {
        self.closed = true;
    }
    pub(super) fn revision(&self, clipboard: u64) -> Result<String, String> {
        if !self.focused || self.closed {
            return Err(FOCUS_REQUIRED.into());
        }
        Ok(format!("{clipboard}:{}", self.epoch))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn returning_focus_does_not_restore_an_old_capture_or_cached_image() {
        let mut focus = FocusVersion::new(1, true);
        let captured = focus.revision(7).unwrap();
        focus.update(2, false);
        assert!(focus.revision(7).is_err());
        focus.update(3, true);
        assert_ne!(focus.revision(7).unwrap(), captured);
        focus.update(4, true);
        assert_eq!(focus.revision(7).unwrap(), "7:3");
    }
    #[test]
    fn background_and_closed_owners_cannot_read_another_windows_clipboard() {
        let mut first = FocusVersion::new(1, false);
        let second = FocusVersion::new(2, true);
        assert!(first.revision(7).is_err());
        assert!(second.revision(7).is_ok());
        first.update(3, true);
        assert_ne!(first.revision(7).unwrap(), second.revision(7).unwrap());
        first.close();
        first.update(4, false);
        first.update(5, true);
        assert!(first.revision(7).is_err());
    }
}
