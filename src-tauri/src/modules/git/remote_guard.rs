//! Authorize only the local remotes used by this operation, after Git rewrites.
//! Another local process can change configuration or replace a path afterward.
use super::{
    errors::{GitError, Result},
    process::ensure_success,
    types::DEFAULT_TIMEOUT_SECS,
    utils::{owned_repo_root, ResolvedGitDirectory},
};
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};
use std::path::{Path, PathBuf};

fn rejected(detail: &'static str) -> GitError {
    GitError::command("native Git refused", detail)
}

#[derive(Clone, Copy)]
pub(super) enum RemoteAction {
    Fetch,
    Push,
}

fn local_remote(root: &Path, value: &str) -> Result<Option<PathBuf>> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(rejected("Git remote URL is invalid"));
    }
    if value
        .get(..5)
        .is_some_and(|s| s.eq_ignore_ascii_case("file:"))
    {
        let url =
            tauri::Url::parse(value).map_err(|_| rejected("Local Git remote URL is invalid"))?;
        let path = url
            .to_file_path()
            .map_err(|_| rejected("Local Git remote URL cannot be mapped to a file path"))?;
        if path.to_string_lossy().chars().any(char::is_control) {
            return Err(rejected(
                "Local Git remote path contains a control character",
            ));
        }
        return Ok(Some(path));
    }
    if value.contains("://") {
        return Ok(None);
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Ok(Some(path.to_path_buf()));
    }
    if let Some((prefix, _)) = value.split_once(':') {
        if !prefix.contains('/') && !prefix.contains('\\') {
            if cfg!(windows) && prefix.len() == 1 {
                return Err(rejected("Drive-relative Git remote paths are unsupported"));
            }
            return Ok(None);
        }
    }
    Ok(Some(root.join(path)))
}

fn output(repo: &ResolvedGitDirectory, args: &[&str]) -> Result<Option<String>> {
    let output = repo.run(args, DEFAULT_TIMEOUT_SECS)?;
    if output.timed_out || output.truncated {
        return Err(rejected(
            "Git remote configuration could not be checked completely",
        ));
    }
    if output.exit_code == Some(1) {
        return Ok(None);
    }
    ensure_success(&output, "inspect Git remote configuration")?;
    let text = std::str::from_utf8(&output.stdout)
        .map_err(|_| rejected("Git remote configuration is unreadable"))?;
    Ok(Some(text.trim_end_matches(['\r', '\n']).to_owned()))
}

fn nul_values(repo: &ResolvedGitDirectory, args: &[&str]) -> Result<Vec<String>> {
    let result = repo.run(args, DEFAULT_TIMEOUT_SECS)?;
    if result.timed_out || result.truncated {
        return Err(rejected(
            "Git remote configuration could not be checked completely",
        ));
    }
    if result.exit_code == Some(1) {
        return Ok(Vec::new());
    }
    ensure_success(&result, "inspect Git remote configuration")?;
    if !result.stdout.is_empty() && result.stdout.last() != Some(&0) {
        return Err(rejected("Git remote configuration is not NUL-delimited"));
    }
    result
        .stdout
        .split(|byte| *byte == 0)
        .take(result.stdout.iter().filter(|byte| **byte == 0).count())
        .map(|value| {
            std::str::from_utf8(value)
                .map(str::to_owned)
                .map_err(|_| rejected("Git remote configuration is unreadable"))
        })
        .collect()
}

fn config_values(repo: &ResolvedGitDirectory, key: &str) -> Result<Vec<String>> {
    nul_values(repo, &["config", "--null", "--get-all", key])
}

fn setting(repo: &ResolvedGitDirectory, key: &str) -> Result<Option<String>> {
    let values = config_values(repo, key)?;
    let value = values.last().cloned();
    if value
        .as_ref()
        .is_some_and(|v| v.chars().any(char::is_control))
    {
        return Err(rejected("Git remote URL contains a control character"));
    }
    Ok(value)
}

fn check_url(value: &str) -> Result<()> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(rejected(
            "Git remote URL contains a control character or is empty",
        ));
    }
    Ok(())
}

// Read rewrites with NUL framing. Git resolves ordinary rewrites; push-only
// rewrites select the longest prefix here because Git lacks a NUL-framed
// per-URL push resolver. Ambiguous equal-length choices are refused.
fn check_rewrites(
    repo: &ResolvedGitDirectory,
    raw: &str,
    push_instead: bool,
) -> Result<Option<String>> {
    let keys = nul_values(
        repo,
        &[
            "config",
            "--null",
            "--name-only",
            "--get-regexp",
            r"^url\..*\.(insteadof|pushinsteadof)$",
        ],
    )?;
    let mut best: Option<(usize, String)> = None;
    for key in keys {
        let lower = key.to_ascii_lowercase();
        let suffix = if lower.ends_with(".pushinsteadof") {
            ".pushinsteadof"
        } else {
            ".insteadof"
        };
        if suffix == ".pushinsteadof" && !push_instead {
            continue;
        }
        for prefix in config_values(repo, &key)? {
            if !raw.starts_with(&prefix) {
                continue;
            }
            let base = &key[4..key.len() - suffix.len()];
            check_url(base)?;
            if prefix.chars().any(char::is_control) {
                return Err(rejected("Git remote rewrite contains a control character"));
            }
            if push_instead && suffix == ".pushinsteadof" {
                let rewritten = format!("{}{}", base, &raw[prefix.len()..]);
                if best
                    .as_ref()
                    .is_some_and(|(len, previous)| *len == prefix.len() && *previous != rewritten)
                {
                    return Err(rejected(
                        "Ambiguous Git push URL rewrites cannot be inspected safely",
                    ));
                }
                if best.as_ref().is_none_or(|(len, _)| prefix.len() > *len) {
                    best = Some((prefix.len(), rewritten));
                }
            }
        }
    }
    Ok(best.map(|(_, value)| value))
}

fn resolved_single(repo: &ResolvedGitDirectory, args: &[&str]) -> Result<String> {
    let result = repo.run(args, DEFAULT_TIMEOUT_SECS)?;
    if result.timed_out || result.truncated {
        return Err(rejected("Git remote URL could not be resolved completely"));
    }
    ensure_success(&result, "resolve Git remote URL")?;
    let bytes = result
        .stdout
        .strip_suffix(b"\n")
        .ok_or_else(|| rejected("Git remote URL response is invalid"))?;
    let value = std::str::from_utf8(bytes).map_err(|_| rejected("Git remote URL is unreadable"))?;
    check_url(value)?;
    Ok(value.to_owned())
}

fn resolve_url(
    repo: &ResolvedGitDirectory,
    raw: &str,
    push: bool,
    explicit_push: bool,
) -> Result<String> {
    check_url(raw)?;
    if let Some(rewritten) = check_rewrites(repo, raw, push && !explicit_push)? {
        check_url(&rewritten)?;
        return Ok(rewritten);
    }
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| rejected("Cannot allocate Git remote inspection"))?;
    let name = format!("oarlock-inspect-{:032x}", u128::from_le_bytes(random));
    let key = format!("remote.{name}.url");
    if !config_values(repo, &key)?.is_empty() {
        return Err(rejected("Git remote inspection name is unavailable"));
    }
    let config = format!("{key}={raw}");
    // ls-remote --get-url resolves the synthetic remote without network access;
    // the unique name prevents interpreting a raw path as another remote name.
    resolved_single(
        repo,
        &["-c", &config, "ls-remote", "--get-url", "--", &name],
    )
}

fn boolean(repo: &ResolvedGitDirectory, key: &str) -> Result<bool> {
    match output(repo, &["config", "--type=bool", "--get", key])?.as_deref() {
        None | Some("false") => Ok(false),
        Some("true") => Ok(true),
        _ => Err(rejected("Git remote boolean setting is invalid")),
    }
}

fn skipped_by_fetch_all(repo: &ResolvedGitDirectory, name: &str) -> Result<bool> {
    // Git treats the deprecated skipDefaultUpdate as an alias and takes
    // whichever setting occurs last, even across included configuration files.
    let escaped = name.replace('.', "\\.");
    let pattern = format!(r"^remote\.{escaped}\.(skipfetchall|skipdefaultupdate)$");
    let entries = output(
        repo,
        &["config", "--null", "--type=bool", "--get-regexp", &pattern],
    )?
    .unwrap_or_default();
    let mut skipped = false;
    for entry in entries.split('\0').filter(|entry| !entry.is_empty()) {
        skipped = match entry.split_once('\n').map(|(_, value)| value) {
            Some("true") => true,
            Some("false") => false,
            _ => return Err(rejected("Git remote boolean setting is invalid")),
        };
    }
    Ok(skipped)
}

fn branch(repo: &ResolvedGitDirectory) -> Result<Option<String>> {
    output(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
}

pub(super) fn inspect(
    registry: &WorkspaceRegistry,
    repo: &ResolvedGitDirectory,
    action: RemoteAction,
) -> Result<()> {
    let remotes = output(repo, &["remote"])?.unwrap_or_default();
    let names: Vec<&str> = remotes.lines().collect();
    if names.len() > 128
        || names.iter().any(|name| {
            name.is_empty()
                || name.len() > 255
                || name.starts_with('-')
                || name
                    .bytes()
                    .any(|b| !(b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/')))
        })
    {
        return Err(rejected("Git remote name cannot be inspected safely"));
    }
    let branch = branch(repo)?;
    let branch_value = |suffix: &str| -> Result<Option<String>> {
        match &branch {
            Some(name) => setting(repo, &format!("branch.{name}.{suffix}")),
            None => Ok(None),
        }
    };
    let selected: Vec<String> =
        if matches!(action, RemoteAction::Fetch) && boolean(repo, "fetch.all")? {
            let mut selected = Vec::new();
            for name in &names {
                if !skipped_by_fetch_all(repo, name)? {
                    selected.push((*name).to_owned());
                }
            }
            selected
        } else {
            let configured = match action {
                RemoteAction::Fetch => branch_value("remote")?,
                RemoteAction::Push => branch_value("pushRemote")?
                    .or(setting(repo, "remote.pushDefault")?)
                    .or(branch_value("remote")?),
            };
            vec![configured.unwrap_or_else(|| {
                if names.len() == 1 {
                    names[0].to_owned()
                } else {
                    "origin".to_owned()
                }
            })]
        };
    for remote in selected {
        let named = names.contains(&remote.as_str());
        let urls = if named {
            config_values(repo, &format!("remote.{remote}.url"))?
        } else {
            vec![remote.clone()]
        };
        if urls.is_empty() {
            return Err(rejected("Git remote URL is unavailable"));
        }
        let push_urls = if named && matches!(action, RemoteAction::Push) {
            config_values(repo, &format!("remote.{remote}.pushurl"))?
        } else {
            Vec::new()
        };
        let explicit_push = !push_urls.is_empty();
        let effective = if explicit_push { push_urls } else { urls };
        for raw in effective
            .iter()
            .take(if matches!(action, RemoteAction::Fetch) {
                1
            } else {
                usize::MAX
            })
        {
            let value = resolve_url(
                repo,
                raw,
                matches!(action, RemoteAction::Push),
                explicit_push,
            )?;
            let Some(path) = local_remote(&repo.local_path, &value)? else {
                continue;
            };
            let canonical = std::fs::canonicalize(path)
                .map_err(|_| rejected("Local Git remote cannot be inspected"))?;
            if canonical.to_string_lossy().chars().any(char::is_control) {
                return Err(rejected(
                    "Local Git remote path contains a control character",
                ));
            }
            if !registry.is_authorized(&canonical) {
                return Err(GitError::command("native Git refused", format!("Local Git remote {} is outside the authorized workspace. Open its folder in Oarlock and retry.", canonical.display())));
            }
            drop(owned_repo_root(
                registry,
                &canonical.to_string_lossy(),
                &WorkspaceEnv::Local,
            )?);
        }
    }
    Ok(())
}
