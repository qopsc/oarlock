//! Validate a candidate's index against native-authorized entry transitions.
//! SHA-1 here checks Git's wire format, not authenticity. Authorization comes
//! from the captured baseline and explicit entry values, not candidate digests.
use sha1::{Digest, Sha1};
use std::{collections::BTreeMap, time::SystemTime};

pub const MAX_INDEX_BYTES: usize = 32 * 1024 * 1024;
const MAX_ENTRIES: usize = 250_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryValue {
    pub mode: u32,
    pub oid: [u8; 20],
}
#[derive(Debug, PartialEq, Eq)]
pub enum IndexError {
    Malformed,
    Unsupported,
    OutsideSelection,
    UnexpectedValue,
}
impl std::fmt::Display for IndexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Malformed => "Candidate Git index is malformed or exceeds the staging limit",
            Self::Unsupported => {
                "This Git index format or state is not supported by isolated publication"
            }
            Self::OutsideSelection => "Candidate Git index changed an entry outside the selection",
            Self::UnexpectedValue => {
                "Candidate Git index does not match the authorized content and file mode"
            }
        })
    }
}
impl std::error::Error for IndexError {}

struct Entry<'a> {
    raw: &'a [u8],
    value: EntryValue,
    flags: u16,
}
fn u32_at(bytes: &[u8], at: usize) -> Result<u32, IndexError> {
    Ok(u32::from_be_bytes(
        bytes
            .get(at..at + 4)
            .ok_or(IndexError::Malformed)?
            .try_into()
            .unwrap(),
    ))
}
fn valid_path(path: &[u8]) -> bool {
    !path.is_empty()
        && path.len() <= 4095
        && !path.contains(&0)
        && !path.contains(&b'\\')
        && !path.contains(&b':')
        && path.split(|b| *b == b'/').all(|part| {
            !part.is_empty() && part != b"." && part != b".." && !part.eq_ignore_ascii_case(b".git")
        })
}
fn parse(bytes: &[u8]) -> Result<BTreeMap<Vec<u8>, Entry<'_>>, IndexError> {
    if bytes.len() < 32 || bytes.len() > MAX_INDEX_BYTES || &bytes[..4] != b"DIRC" {
        return Err(IndexError::Malformed);
    }
    if u32_at(bytes, 4)? != 2 {
        return Err(IndexError::Unsupported);
    }
    let end = bytes.len() - 20;
    if Sha1::digest(&bytes[..end])[..] != bytes[end..] {
        return Err(IndexError::Malformed);
    }
    let count = u32_at(bytes, 8)? as usize;
    if count > MAX_ENTRIES {
        return Err(IndexError::Malformed);
    }
    let mut offset = 12;
    let mut entries = BTreeMap::new();
    let mut previous: &[u8] = &[];
    for _ in 0..count {
        let data = bytes.get(offset..end).ok_or(IndexError::Malformed)?;
        if data.len() < 63 {
            return Err(IndexError::Malformed);
        }
        let flags = u16::from_be_bytes(data[60..62].try_into().unwrap());
        if flags & 0x7000 != 0 {
            return Err(IndexError::Unsupported);
        } // extended or unmerged
        let length = data[62..]
            .iter()
            .position(|b| *b == 0)
            .ok_or(IndexError::Malformed)?;
        let path = &data[62..62 + length];
        if !valid_path(path) || length != usize::from(flags & 0x0fff) || path <= previous {
            return Err(IndexError::Malformed);
        }
        // A stage-zero index is a tree: a file cannot also be an ancestor of
        // another entry. Ancestors need not be adjacent (a, a.b, a/child).
        if path
            .iter()
            .enumerate()
            .any(|(i, b)| *b == b'/' && entries.contains_key(&path[..i]))
        {
            return Err(IndexError::Malformed);
        }
        let padded = (62 + length + 8) & !7;
        let raw = data.get(..padded).ok_or(IndexError::Malformed)?;
        if raw[62 + length..].iter().any(|b| *b != 0) {
            return Err(IndexError::Malformed);
        }
        let mode = u32_at(raw, 24)?;
        if !matches!(mode, 0o100644 | 0o100755 | 0o120000) {
            return Err(IndexError::Unsupported);
        }
        if raw[40..60].iter().all(|b| *b == 0) {
            return Err(IndexError::Malformed);
        }
        entries.insert(
            path.to_vec(),
            Entry {
                raw,
                value: EntryValue {
                    mode,
                    oid: raw[40..60].try_into().unwrap(),
                },
                flags,
            },
        );
        previous = path;
        offset += padded;
    }
    // Accept and discard only known disposable caches. Never trust TREE's
    // cached tree OIDs, or silently drop semantic state such as resolve-undo.
    while offset < end {
        let signature = bytes.get(offset..offset + 4).ok_or(IndexError::Malformed)?;
        if !matches!(signature, b"TREE" | b"EOIE" | b"IEOT" | b"UNTR" | b"FSMN") {
            return Err(IndexError::Unsupported);
        }
        let length = u32_at(bytes, offset + 4)? as usize;
        offset = offset
            .checked_add(8)
            .and_then(|n| n.checked_add(length))
            .ok_or(IndexError::Malformed)?;
        if offset > end {
            return Err(IndexError::Malformed);
        }
    }
    Ok(entries)
}

/// The index timestamp is part of its cache semantics: moving unchanged stat
/// entries to a newer index can hide edits that Git previously considered racy.
#[derive(Clone, Copy)]
pub struct Baseline<'a> {
    pub bytes: &'a [u8],
    pub modified: SystemTime,
}
impl Baseline<'_> {
    fn identity(self) -> ([u8; 32], SystemTime) {
        (sha2::Sha256::digest(self.bytes).into(), self.modified)
    }
    fn racy(self, entry: &Entry<'_>) -> bool {
        // Git builds differ in subsecond stat support. Compare whole seconds
        // conservatively; older entries retain their fast stat cache.
        self.modified
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(true, |age| {
                age.as_secs() > u64::from(u32::MAX)
                    || u64::from(u32::from_be_bytes(entry.raw[8..12].try_into().unwrap()))
                        >= age.as_secs()
            })
    }
}

/// Not a complete transaction permit: object validation/publication, source
/// identity checks and an exclusive native destination are still required.
#[derive(Debug)]
pub struct PlannedIndex {
    bytes: Vec<u8>,
    baseline: Option<([u8; 32], SystemTime)>,
}
impl PlannedIndex {
    pub(super) fn matches_baseline(&self, baseline: Option<Baseline<'_>>) -> bool {
        self.baseline == baseline.map(Baseline::identity)
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// Expected values must come from native-authorized input transformations, not
/// the worker's result manifest. None is an explicitly authorized removal.
pub fn plan(
    baseline: Option<Baseline<'_>>,
    candidate: &[u8],
    expected: &BTreeMap<Vec<u8>, Option<EntryValue>>,
) -> Result<PlannedIndex, IndexError> {
    if expected.len() > MAX_ENTRIES || expected.keys().any(|p| !valid_path(p)) {
        return Err(IndexError::Malformed);
    }
    let before = baseline
        .map(|b| parse(b.bytes))
        .transpose()?
        .unwrap_or_default();
    let after = parse(candidate)?;
    for (path, entry) in &before {
        if !expected.contains_key(path) {
            let current = after.get(path).ok_or(IndexError::OutsideSelection)?;
            if current.value != entry.value || current.flags != entry.flags {
                return Err(IndexError::OutsideSelection);
            }
        }
    }
    for (path, entry) in &after {
        if !expected.contains_key(path) && !before.contains_key(path) {
            return Err(IndexError::OutsideSelection);
        }
        if let Some(value) = expected.get(path) {
            if value.as_ref() != Some(&entry.value) || entry.flags & 0x8000 != 0 {
                return Err(IndexError::UnexpectedValue);
            }
        }
    }
    for (path, value) in expected {
        if value.is_some() != after.contains_key(path) {
            return Err(IndexError::UnexpectedValue);
        }
    }
    let mut bytes = b"DIRC\0\0\0\x02".to_vec();
    bytes.extend_from_slice(&(after.len() as u32).to_be_bytes());
    for (path, entry) in after {
        let selected = expected.contains_key(&path);
        let original = if selected { &entry } else { &before[&path] };
        let start = bytes.len();
        bytes.extend_from_slice(original.raw);
        if selected || baseline.is_some_and(|b| b.racy(original)) {
            // Selected stats refer to the candidate directory. Unselected
            // racy stats lose their protection when the index mtime advances.
            // Preserve modes, OIDs and intentional assume-unchanged flags.
            bytes[start..start + 24].fill(0);
            bytes[start + 28..start + 40].fill(0);
        }
    }
    let digest = Sha1::digest(&bytes);
    bytes.extend_from_slice(&digest);
    Ok(PlannedIndex {
        bytes,
        baseline: baseline.map(Baseline::identity),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn baseline(bytes: &[u8]) -> Option<Baseline<'_>> {
        Some(Baseline {
            bytes,
            modified: SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1),
        })
    }
    fn index(entries: &[(&str, u8)], extension: Option<&[u8]>) -> Vec<u8> {
        let mut out = b"DIRC\0\0\0\x02".to_vec();
        out.extend_from_slice(&(entries.len() as u32).to_be_bytes());
        for (path, oid) in entries {
            let start = out.len();
            out.extend_from_slice(&[0; 24]);
            out.extend_from_slice(&0o100644u32.to_be_bytes());
            out.extend_from_slice(&[0; 12]);
            out.extend_from_slice(&[*oid; 20]);
            out.extend_from_slice(&(path.len() as u16).to_be_bytes());
            out.extend_from_slice(path.as_bytes());
            let padded = (out.len() - start + 8) & !7;
            out.resize(start + padded, 0);
        }
        if let Some(extension) = extension {
            out.extend_from_slice(extension);
        }
        let digest = Sha1::digest(&out);
        out.extend_from_slice(&digest);
        out
    }
    fn expected(path: &str, oid: u8) -> BTreeMap<Vec<u8>, Option<EntryValue>> {
        BTreeMap::from([(
            path.as_bytes().to_vec(),
            Some(EntryValue {
                mode: 0o100644,
                oid: [oid; 20],
            }),
        )])
    }
    #[test]
    fn only_exact_authorized_entry_transitions_can_be_published() {
        let before = index(&[("a", 1), ("b", 2)], None);
        assert!(plan(
            baseline(&before),
            &index(&[("a", 3), ("b", 2)], None),
            &expected("a", 3)
        )
        .is_ok());
        assert_eq!(
            plan(
                baseline(&before),
                &index(&[("a", 3), ("b", 4)], None),
                &expected("a", 3)
            )
            .unwrap_err(),
            IndexError::OutsideSelection
        );
        assert_eq!(
            plan(
                baseline(&before),
                &index(&[("a", 3)], None),
                &expected("a", 3)
            )
            .unwrap_err(),
            IndexError::OutsideSelection
        );
        assert_eq!(
            plan(
                baseline(&before),
                &index(&[("a", 4), ("b", 2)], None),
                &expected("a", 3)
            )
            .unwrap_err(),
            IndexError::UnexpectedValue
        );
        assert!(plan(None, &index(&[("a", 3)], None), &expected("a", 3)).is_ok());
        let remove = BTreeMap::from([(b"a".to_vec(), None)]);
        assert!(plan(baseline(&before), &index(&[("b", 2)], None), &remove).is_ok());
    }
    #[test]
    fn tree_caches_cannot_substitute_other_commit_contents() {
        let input = index(&[("a", 1)], Some(b"TREE\0\0\0\x04evil"));
        let result = plan(baseline(&input), &input, &BTreeMap::new()).unwrap();
        assert_eq!(result.bytes(), index(&[("a", 1)], None));
        assert!(parse(&index(&[("a", 1)], Some(b"REUC\0\0\0\0"))).is_err());
        assert!(parse(&index(&[("a", 1)], Some(b"link\0\0\0\0"))).is_err());
    }
    #[test]
    fn only_selected_or_racy_stat_caches_are_invalidated() {
        let mut input = index(&[("old", 1), ("racy", 2), ("selected", 3)], None);
        // Each one of these entries is 72 bytes long. Give all stat caches
        // recognizable bytes, with one old and one same-second mtime.
        for (n, seconds) in [10u32, 20, 10].into_iter().enumerate() {
            let start = 12 + n * 72;
            input[start..start + 24].fill(1);
            input[start + 28..start + 40].fill(1);
            input[start + 8..start + 12].copy_from_slice(&seconds.to_be_bytes());
        }
        let end = input.len() - 20;
        let checksum = Sha1::digest(&input[..end]);
        input[end..].copy_from_slice(&checksum);
        let before = Baseline {
            bytes: &input,
            modified: SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(20),
        };
        let result = plan(Some(before), &input, &expected("selected", 3)).unwrap();
        let parsed = parse(result.bytes()).unwrap();
        assert_eq!(
            parsed[b"old".as_slice()].raw,
            parse(&input).unwrap()[b"old".as_slice()].raw
        );
        for key in [b"racy".as_slice(), b"selected".as_slice()] {
            let raw = parsed[key].raw;
            assert_eq!(&raw[..24], &[0; 24]);
            assert_eq!(&raw[28..40], &[0; 12]);
        }
        assert!(!result.matches_baseline(Some(Baseline {
            modified: SystemTime::UNIX_EPOCH,
            ..before
        })));
    }
    #[test]
    fn malformed_indices_never_become_publication_plans() {
        for name in [
            "../a",
            "a/../../b",
            ".git/config",
            "a/.GIT/index",
            "/a",
            "a//b",
            "C:/x",
        ] {
            assert!(parse(&index(&[(name, 1)], None)).is_err(), "{name}");
        }
        assert!(parse(&index(&[("a", 0)], None)).is_err());
        assert!(parse(&index(&[("a", 1), ("a/b", 2)], None)).is_err());
        assert!(parse(&index(&[("a", 1), ("a.b", 2), ("a/child", 3)], None)).is_err());
        assert!(parse(&index(&[("b", 1), ("a", 1)], None)).is_err());
        assert!(parse(&index(&[("a", 1), ("a", 1)], None)).is_err());
        let mut corrupt = index(&[("a", 1)], None);
        corrupt[30] ^= 1;
        assert!(parse(&corrupt).is_err());
        assert!(parse(&index(&[("a", 1)], Some(b"TREE\xff\xff\xff\xff"))).is_err());
        let valid = index(&[("a", 1)], None);
        for end in 0..valid.len() {
            assert!(parse(&valid[..end]).is_err());
        }
    }
}
