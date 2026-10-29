//! Admission for an isolated candidate, before materializing configuration or
//! executing Git. The captured config is data, never a ready-to-copy config file.
//! This is not an execution permit: snapshot and publication validation also apply.
use std::collections::BTreeMap;

const MAX_CONFIG_BYTES: usize = 256 * 1024;
const MAX_CONFIG_ENTRIES: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    IncompleteConfiguration,
    ExecutableExtension(&'static str),
    UnsupportedConfiguration(&'static str),
}
impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IncompleteConfiguration => write!(f, "Git configuration could not be captured completely. No candidate was executed."),
            Self::ExecutableExtension(kind) => write!(f, "This action requires {kind}, which isolated native Git does not support in this release. No hook or helper was skipped. Run the action in the terminal."),
            Self::UnsupportedConfiguration(key) => write!(f, "Git configuration {key} is not supported by isolated native Git. Run the action in the terminal."),
        }
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

/// Only these scalar settings enter a candidate config. Repository extensions,
/// includes, URLs, aliases, executables and paths never get copied wholesale.
/// The initial local-mutation adapter deliberately rejects other settings; each
/// additional supported setting needs a semantic test before expanding this list.
#[derive(Debug, PartialEq, Eq)]
pub struct CandidateConfig {
    values: BTreeMap<String, Option<String>>,
}
impl CandidateConfig {
    pub fn capture(bytes: &[u8], executable_hook_present: bool) -> Result<Self, Refusal> {
        if executable_hook_present {
            return Err(Refusal::ExecutableExtension("executable Git hooks"));
        }
        let entries = parse_config(bytes)?;
        let mut values = BTreeMap::new();
        for (key, value) in entries {
            // Section and variable are case-insensitive. Subsections are not:
            // never lowercase arbitrary filter/remote/hook identifiers.
            let (section, tail) = key
                .split_once('.')
                .ok_or(Refusal::IncompleteConfiguration)?;
            let section = section.to_ascii_lowercase();
            let variable = tail.rsplit('.').next().unwrap_or(tail).to_ascii_lowercase();
            let simple = !tail.contains('.');
            let kind = match (section.as_str(), variable.as_str()) {
                ("hook", _) => Some("configured Git hooks"),
                ("filter", _) => Some("Git clean/smudge/process filters"),
                ("credential", _) => Some("credential helpers"),
                ("gpg", _) => Some("external signing programs"),
                ("merge", "driver") => Some("external merge drivers"),
                ("diff", "external" | "command" | "textconv") => Some("external diff converters"),
                ("core", "hookspath") => Some("a custom hooks directory"),
                ("core", "sshcommand" | "askpass") => Some("external authentication helpers"),
                ("gc", "recentobjectshook") | ("uploadpack", "packobjectshook") => {
                    Some("object-processing hooks")
                }
                _ => None,
            };
            if let Some(kind) = kind {
                return Err(Refusal::ExecutableExtension(kind));
            }
            let normalized = format!("{section}.{variable}");
            if simple
                && matches!(
                    normalized.as_str(),
                    "core.fsmonitor" | "commit.gpgsign" | "tag.gpgsign" | "push.gpgsign"
                )
            {
                // False is safe, but preserve the distinction between false,
                // empty (also false), an implicit true and an executable path.
                if !matches!(value, Some(v) if v.is_empty() || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("no") || v.eq_ignore_ascii_case("off") || v == "0")
                {
                    return Err(Refusal::ExecutableExtension(
                        "a filesystem monitor or signing program",
                    ));
                }
                values.insert(normalized, Some("false".into()));
                continue;
            }
            let supported = simple
                && matches!(
                    normalized.as_str(),
                    "core.repositoryformatversion"
                        | "core.bare"
                        | "core.filemode"
                        | "core.logallrefupdates"
                        | "core.ignorecase"
                        | "core.precomposeunicode"
                        | "core.autocrlf"
                        | "core.eol"
                        | "core.safecrlf"
                        | "core.symlinks"
                        | "core.protecthfs"
                        | "core.protectntfs"
                        | "core.quotepath"
                        | "user.name"
                        | "user.email"
                        | "i18n.commitencoding"
                        | "commit.cleanup"
                );
            if !supported {
                // Return only a bounded, neutral category, not arbitrary
                // subsection text (a remote URL or other secret may be there).
                return Err(Refusal::UnsupportedConfiguration("an unrecognized setting"));
            }
            if normalized == "core.repositoryformatversion" && value != Some("0") {
                return Err(Refusal::UnsupportedConfiguration(
                    "core.repositoryformatversion",
                ));
            }
            // Duplicate scalar entries have Git's last-value semantics. Unsafe
            // earlier values are refused above, never erased by a later value.
            values.insert(normalized, value.map(str::to_owned));
        }
        Ok(Self { values })
    }

    pub fn values(&self) -> &BTreeMap<String, Option<String>> {
        &self.values
    }
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
    #[test]
    fn hooks_cannot_hide_behind_a_disabled_filesystem_hooks_path() {
        for config in [
            "hook.late.command\n/bin/sh -c bad\0",
            "HOOK.late.EVENT\npost-commit\0",
            "core.hookspath\n/dev/null\0",
            "filter.lfs.process\ngit-lfs filter-process\0",
            "gpg.ssh.defaultkeycommand\nsecret-command\0",
            "core.fsmonitor\n/tmp/hook\0",
            "core.fsmonitor\0",
            "commit.gpgsign\nyes\0",
            "credential.helper\n\0",
        ] {
            assert!(
                matches!(
                    CandidateConfig::capture(config.as_bytes(), false),
                    Err(Refusal::ExecutableExtension(_))
                ),
                "{config}"
            );
        }
        assert!(matches!(
            CandidateConfig::capture(b"", true),
            Err(Refusal::ExecutableExtension(_))
        ));
    }
    #[test]
    fn unknown_or_context_redirecting_settings_never_enter_a_candidate() {
        for key in [
            "core.worktree",
            "core.attributesfile",
            "include.path",
            "includeif.gitdir:private.path",
            "extensions.worktreeconfig",
            "extensions.refstorage",
            "core.futureexecution",
        ] {
            assert!(
                CandidateConfig::capture(format!("{key}\nsecret\0").as_bytes(), false).is_err()
            );
        }
        let error = CandidateConfig::capture(b"remote.https://token@host.url\nsecret\0", false)
            .unwrap_err()
            .to_string();
        assert!(!error.contains("token"));
        assert!(!error.contains("secret"));
    }
    #[test]
    fn safe_scalars_preserve_git_boolean_and_last_value_semantics() {
        let config = CandidateConfig::capture(b"user.name\nold\0USER.NAME\nnew\0core.filemode\0core.fsmonitor\noff\0commit.gpgsign\n\0", false).unwrap();
        assert_eq!(config.values()["user.name"].as_deref(), Some("new"));
        assert_eq!(config.values()["core.filemode"], None);
        assert_eq!(config.values()["core.fsmonitor"].as_deref(), Some("false"));
        assert!(CandidateConfig::capture(
            b"core.fsmonitor\n/tmp/hook\0core.fsmonitor\nfalse\0",
            false
        )
        .is_err());
    }
    #[test]
    fn effective_config_capture_refuses_hooks_declared_outside_the_hooks_directory() {
        use std::process::Command;
        let root = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let result = Command::new("git")
                .arg("-C")
                .arg(root.path())
                .args(args)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env(
                    "GIT_CONFIG_GLOBAL",
                    if cfg!(windows) { "NUL" } else { "/dev/null" },
                )
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            result.stdout
        };
        git(&["init", "-q"]);
        git(&["config", "hook.fixture.command", "echo ran > hook-marker"]);
        git(&["config", "hook.fixture.event", "post-index-change"]);
        let config = git(&["config", "--null", "--list"]);
        assert!(matches!(
            CandidateConfig::capture(&config, false),
            Err(Refusal::ExecutableExtension("configured Git hooks"))
        ));
        assert!(!root.path().join("hook-marker").exists());
        // Positive control on Git versions implementing configuration hooks.
        // The parser/refusal above is also tested on older supported versions.
        let keys = git(&["help", "--config"]);
        if String::from_utf8_lossy(&keys).contains("hook.<friendly-name>.command") {
            std::fs::write(root.path().join("file"), "fixture").unwrap();
            git(&["-c", "core.hooksPath=/dev/null", "add", "file"]);
            assert!(root.path().join("hook-marker").exists());
        }
    }
}
