//! Content identities for transferring objects into an isolated Git candidate.
//!
//! A Git SHA-1 alone is not authorization. The native side must independently
//! capture the authorized bytes and retain their SHA-256 digest; a candidate's
//! claimed digest or object ID must never be used as that capture.
use sha1::{Digest, Sha1};
use sha2::Sha256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectKind {
    Blob,
    Tree,
    Commit,
    Tag,
}

impl ObjectKind {
    fn name(self) -> &'static str {
        match self {
            Self::Blob => "blob",
            Self::Tree => "tree",
            Self::Commit => "commit",
            Self::Tag => "tag",
        }
    }
}

/// Identity captured from native-authorized bytes, not from a worker manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectIdentity {
    kind: ObjectKind,
    len: usize,
    git_oid: [u8; 20],
    content_sha256: [u8; 32],
}

#[derive(Debug, PartialEq, Eq)]
pub enum ObjectError {
    TooLarge,
    Mismatch,
}

impl std::fmt::Display for ObjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::TooLarge => "Git object exceeds the operation's input limit",
            Self::Mismatch => "Git object does not match the authorized content",
        })
    }
}

impl std::error::Error for ObjectError {}

impl ObjectIdentity {
    /// The caller supplies its operation-wide limit; this function never
    /// allocates a second copy of the content.
    pub fn capture(
        kind: ObjectKind,
        content: &[u8],
        max_bytes: usize,
    ) -> Result<Self, ObjectError> {
        if content.len() > max_bytes {
            return Err(ObjectError::TooLarge);
        }
        let header = format!("{} {}\0", kind.name(), content.len());
        let mut git = Sha1::new();
        git.update(header.as_bytes());
        git.update(content);
        let mut strong = Sha256::new();
        strong.update(header.as_bytes());
        strong.update(content);
        Ok(Self {
            kind,
            len: content.len(),
            git_oid: git.finalize().into(),
            content_sha256: strong.finalize().into(),
        })
    }

    pub fn git_oid(&self) -> [u8; 20] {
        self.git_oid
    }

    /// Check the returned payload against a separately captured native input.
    /// This checks bytes and type only; source ownership, object graph,
    /// semantic validity and durable publication must be validated separately.
    pub fn verify(
        &self,
        kind: ObjectKind,
        content: &[u8],
        max_bytes: usize,
    ) -> Result<(), ObjectError> {
        let observed = Self::capture(kind, content, max_bytes)?;
        if observed != *self {
            return Err(ObjectError::Mismatch);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        process::{Command, Stdio},
    };

    #[test]
    fn blob_identity_matches_real_git() {
        let content = b"hello\0world\n";
        let identity = ObjectIdentity::capture(ObjectKind::Blob, content, content.len()).unwrap();
        let mut git = Command::new("git")
            .args(["hash-object", "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("Git is required for this integration test");
        git.stdin.take().unwrap().write_all(content).unwrap();
        let output = git.wait_with_output().unwrap();
        assert!(output.status.success());
        let actual: String = identity
            .git_oid()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(actual, String::from_utf8(output.stdout).unwrap().trim());
    }

    #[test]
    fn candidate_cannot_change_content_or_object_kind() {
        let baseline = ObjectIdentity::capture(ObjectKind::Blob, b"abc", 3).unwrap();
        assert_eq!(baseline.verify(ObjectKind::Blob, b"abc", 3), Ok(()));
        assert_eq!(
            baseline.verify(ObjectKind::Blob, b"abd", 3),
            Err(ObjectError::Mismatch)
        );
        assert_eq!(
            baseline.verify(ObjectKind::Tree, b"abc", 3),
            Err(ObjectError::Mismatch)
        );
        assert_eq!(
            baseline.verify(ObjectKind::Blob, b"ab", 3),
            Err(ObjectError::Mismatch)
        );
    }

    #[test]
    fn limits_apply_to_capture_and_returned_payload() {
        assert_eq!(
            ObjectIdentity::capture(ObjectKind::Blob, b"abc", 2),
            Err(ObjectError::TooLarge)
        );
        let baseline = ObjectIdentity::capture(ObjectKind::Blob, b"abc", 3).unwrap();
        assert_eq!(
            baseline.verify(ObjectKind::Blob, b"abcd", 3),
            Err(ObjectError::TooLarge)
        );
        assert!(ObjectIdentity::capture(ObjectKind::Blob, b"", 0).is_ok());
    }
}
