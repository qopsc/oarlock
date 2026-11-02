//! Parse shell control data before display-output truncation. Memory is bounded
//! by a marker and one path; ordinary output is never retained here.
const MAX_PATH_BYTES: usize = 128 * 1024;

pub(super) struct CwdFrame {
    marker: Vec<u8>,
    matched: usize,
    reading: bool,
    overflow: bool,
    path: Vec<u8>,
    pub value: Option<String>,
}
impl CwdFrame {
    pub fn new(sentinel: &str) -> Self {
        Self {
            marker: format!("\n{sentinel}").into_bytes(),
            matched: 0,
            reading: false,
            overflow: false,
            path: Vec::new(),
            value: None,
        }
    }
    pub fn push(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if self.reading {
                if byte == 0 {
                    self.value = (!self.overflow && !self.path.is_empty())
                        .then(|| String::from_utf8(std::mem::take(&mut self.path)).ok())
                        .flatten();
                    self.reading = false;
                } else if self.path.len() < MAX_PATH_BYTES {
                    self.path.push(byte);
                } else {
                    self.overflow = true;
                }
            } else if byte == self.marker[self.matched] {
                self.matched += 1;
                if self.matched == self.marker.len() {
                    self.matched = 0;
                    self.reading = true;
                    self.overflow = false;
                    self.path.clear();
                    self.value = None;
                }
            } else {
                // The marker contains a newline only at its first byte.
                self.matched = usize::from(byte == b'\n');
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_frames_preserve_spaces_newlines_and_unicode() {
        let bytes = b"output\nMARK/path with \nline \xe2\x98\x83 \0\n";
        for split in 0..=bytes.len() {
            let mut parser = CwdFrame::new("MARK");
            parser.push(&bytes[..split]);
            parser.push(&bytes[split..]);
            assert_eq!(parser.value.as_deref(), Some("/path with \nline ☃ "));
        }
    }
    #[test]
    fn incomplete_invalid_and_oversized_frames_never_supply_a_path() {
        for bytes in [
            b"\nMARK/incomplete".as_slice(),
            b"\nMARK\xff\0",
            b"\nMARK\0",
        ] {
            let mut parser = CwdFrame::new("MARK");
            parser.push(bytes);
            assert!(parser.value.is_none());
        }
        let mut parser = CwdFrame::new("MARK");
        parser.push(b"\nMARK");
        parser.push(&vec![b'a'; MAX_PATH_BYTES + 1]);
        parser.push(b"\0");
        assert!(parser.value.is_none());
        assert!(parser.path.len() <= MAX_PATH_BYTES);
    }
}
