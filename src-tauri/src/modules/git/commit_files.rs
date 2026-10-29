//! Decode one commit's NUL-framed raw diff and numstat from the same Git process.
//! `--name-status` suppresses numstat; `--raw --numstat` preserves both sections.
use super::types::GitCommitFileChange;
use std::collections::HashMap;

const MALFORMED: &str = "Git returned an incomplete or malformed commit file list";

pub(super) fn parse(bytes: &[u8]) -> Result<Vec<GitCommitFileChange>, &'static str> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if !bytes.ends_with(&[0]) {
        return Err(MALFORMED);
    }
    // A lossy filename could open a different entry. Report unsupported names
    // instead of presenting an empty list or substituting replacement characters.
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "Commit file names are not valid UTF-8 and cannot be displayed safely")?;
    let mut tokens = text.split_terminator('\0').peekable();
    let mut files = Vec::<GitCommitFileChange>::new();
    let mut by_path = HashMap::new();
    while tokens.peek().is_some_and(|header| header.starts_with(':')) {
        let header = tokens.next().ok_or(MALFORMED)?;
        let mut fields = header[1..].split(' ');
        for _ in 0..2 {
            let mode = fields.next().ok_or(MALFORMED)?;
            if mode.len() != 6 || !mode.bytes().all(|b| matches!(b, b'0'..=b'7')) {
                return Err(MALFORMED);
            }
        }
        let old = fields.next().ok_or(MALFORMED)?;
        let new = fields.next().ok_or(MALFORMED)?;
        if !matches!(old.len(), 40 | 64)
            || old.len() != new.len()
            || !old
                .bytes()
                .chain(new.bytes())
                .all(|b| b.is_ascii_hexdigit())
        {
            return Err(MALFORMED);
        }
        let status = fields.next().ok_or(MALFORMED)?;
        let kind = status.chars().next().ok_or(MALFORMED)?;
        if fields.next().is_some()
            || !matches!(kind, 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U')
            || (!status[1..].is_empty()
                && (!matches!(kind, 'R' | 'C' | 'M')
                    || !status[1..].bytes().all(|b| b.is_ascii_digit())
                    || status[1..].parse::<u32>().map_or(true, |n| n > 100)))
        {
            return Err(MALFORMED);
        }
        let first = tokens.next().filter(|s| !s.is_empty()).ok_or(MALFORMED)?;
        let (original, path) = if matches!(kind, 'R' | 'C') {
            (
                Some(first),
                tokens.next().filter(|s| !s.is_empty()).ok_or(MALFORMED)?,
            )
        } else {
            (None, first)
        };
        if by_path.insert(path, files.len()).is_some() {
            return Err(MALFORMED);
        }
        files.push(GitCommitFileChange {
            path: path.into(),
            original_path: original.map(str::to_owned),
            status: kind.to_string(),
            status_label: status_label_for(kind),
            added: 0,
            removed: 0,
            is_binary: false,
        });
    }
    let mut seen = vec![false; files.len()];
    while let Some(header) = tokens.next() {
        let mut columns = header.splitn(3, '\t');
        let added = columns.next().ok_or(MALFORMED)?;
        let removed = columns.next().ok_or(MALFORMED)?;
        let inline = columns.next().ok_or(MALFORMED)?;
        let (original, path) = if inline.is_empty() {
            (
                Some(tokens.next().ok_or(MALFORMED)?),
                tokens.next().ok_or(MALFORMED)?,
            )
        } else {
            (None, inline)
        };
        let &i = by_path.get(path).ok_or(MALFORMED)?;
        if seen[i] || files[i].original_path.as_deref() != original {
            return Err(MALFORMED);
        }
        seen[i] = true;
        let count = |value: &str| {
            if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err(MALFORMED);
            }
            value.parse::<u32>().map_err(|_| MALFORMED)
        };
        if added == "-" && removed == "-" {
            files[i].is_binary = true;
        } else {
            files[i].added = count(added)?;
            files[i].removed = count(removed)?;
        }
    }
    if seen.iter().any(|present| !present) {
        return Err(MALFORMED);
    }
    Ok(files)
}

pub(super) fn status_label_for(c: char) -> String {
    match c {
        'A' => "Added".into(),
        'M' => "Modified".into(),
        'D' => "Deleted".into(),
        'R' => "Renamed".into(),
        'C' => "Copied".into(),
        'T' => "Type changed".into(),
        'U' => "Unmerged".into(),
        _ => format!("Status {c}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn raw(status: &str, paths: &str) -> String {
        format!(
            ":100644 100644 {} {} {status}\0{paths}",
            "a".repeat(40),
            "b".repeat(40)
        )
    }
    #[test]
    fn framed_paths_keep_tabs_newlines_and_numeric_looking_names() {
        let input = format!(
            "{}{}{}2\t1\told\tname\0-\t-\tbin\nname\00\t0\t\0before\0new\tname\0",
            raw("M", "old\tname\0"),
            raw("M", "bin\nname\0"),
            raw("R100", "before\0new\tname\0")
        );
        let files = parse(input.as_bytes()).unwrap();
        assert_eq!(files[0].path, "old\tname");
        assert_eq!((files[0].added, files[0].removed), (2, 1));
        assert!(files[1].is_binary);
        assert_eq!(files[2].original_path.as_deref(), Some("before"));
        assert_eq!(files[2].path, "new\tname");
    }
    #[test]
    fn incomplete_duplicate_or_disagreeing_sections_are_never_shown_as_complete() {
        let header = raw("M", "a\0");
        for tail in [
            "",
            "1\t0\ta",
            "1\t0\tb\0",
            "1\t0\ta\x001\t0\ta\0",
            "-\t0\ta\0",
            "4294967296\t0\ta\0",
        ] {
            assert!(
                parse(format!("{header}{tail}").as_bytes()).is_err(),
                "{tail:?}"
            );
        }
        assert!(parse(format!("{header}{header}1\t0\ta\0").as_bytes()).is_err());
        let rename = raw("R100", "old\0new\0");
        assert!(parse(format!("{rename}1\t0\t\0wrong\0new\0").as_bytes()).is_err());
        let mut invalid = header.into_bytes();
        invalid.extend_from_slice(b"1\t0\t\xff\0");
        assert!(parse(&invalid).is_err());
        assert!(parse(b"garbage\0").is_err());
    }
}
