//! Parser for `git config --null --list` output, used by the commit guard.
const MAX_CONFIG_BYTES: usize = 256 * 1024;
const MAX_CONFIG_ENTRIES: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    IncompleteConfiguration,
}
impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Git configuration could not be captured completely.")
    }
}
impl std::error::Error for Refusal {}

/// Parse `git config --null --list`. Values may contain newlines and '='; a
/// missing newline means Git's implicit boolean true, not an empty value.
/// Callers must reject a failed, timed-out or truncated capture before this call.
pub fn parse_config(bytes: &[u8]) -> Result<Vec<(&str, Option<&str>)>, Refusal> {
    if bytes.len() > MAX_CONFIG_BYTES || (!bytes.is_empty() && !bytes.ends_with(&[0])) {
        return Err(Refusal::IncompleteConfiguration);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Refusal::IncompleteConfiguration)?;
    let mut entries = Vec::new();
    for record in text.split_terminator('\0') {
        if entries.len() == MAX_CONFIG_ENTRIES {
            return Err(Refusal::IncompleteConfiguration);
        }
        let (key, value) = record
            .split_once('\n')
            .map_or((record, None), |(k, v)| (k, Some(v)));
        // Do not print arbitrary config text (possibly a credential) in errors.
        if key.is_empty() || !key.contains('.') || key.bytes().any(|b| b.is_ascii_control()) {
            return Err(Refusal::IncompleteConfiguration);
        }
        entries.push((key, value));
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_boolean_and_multiline_values_without_reinterpreting_config_syntax() {
        assert_eq!(
            parse_config(b"user.name\nA=B\nC\0core.filemode\0core.bare\n\0").unwrap(),
            vec![
                ("user.name", Some("A=B\nC")),
                ("core.filemode", None),
                ("core.bare", Some(""))
            ]
        );
        assert!(parse_config(b"user.name\nA").is_err());
        assert!(parse_config(b"\0").is_err());
        assert!(parse_config(b"user.name\n\xff\0").is_err());
        assert!(parse_config(&vec![0; MAX_CONFIG_BYTES + 1]).is_err());
    }
}
