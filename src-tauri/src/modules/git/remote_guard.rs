//! Authorize and inspect local Git remotes before network-style operations.
//! Another local process can replace the inspected path afterward.
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
            // Drive-relative paths are ambiguous on Windows; do not classify
            // them as remote SSH and accidentally skip local authorization.
            if cfg!(windows) && prefix.len() == 1 {
                return Err(rejected("Drive-relative Git remote paths are unsupported"));
            }
            return Ok(None);
        }
    }
    Ok(Some(root.join(path)))
}

pub(super) fn inspect(registry: &WorkspaceRegistry, repo: &ResolvedGitDirectory) -> Result<()> {
    let output = repo.run(["remote"], DEFAULT_TIMEOUT_SECS)?;
    ensure_success(&output, "list Git remotes")?;
    if output.truncated {
        return Err(rejected("Git remote list exceeds the inspection limit"));
    }
    let text = std::str::from_utf8(&output.stdout)
        .map_err(|_| rejected("Git remote list is unreadable"))?;
    let mut count = 0usize;
    for name in text.lines() {
        count += 1;
        if count > 128
            || name.is_empty()
            || name.len() > 255
            || name.starts_with('-')
            || name
                .bytes()
                .any(|b| !(b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/')))
        {
            return Err(rejected("Git remote name cannot be inspected safely"));
        }
        for push in [false, true] {
            let mut args = vec!["remote", "get-url", "--all"];
            if push {
                args.push("--push");
            }
            args.extend(["--", name]);
            let urls = repo.run(args, DEFAULT_TIMEOUT_SECS)?;
            ensure_success(&urls, "inspect Git remote URL")?;
            if urls.truncated {
                return Err(rejected("Git remote URLs exceed the inspection limit"));
            }
            let urls = std::str::from_utf8(&urls.stdout)
                .map_err(|_| rejected("Git remote URL is unreadable"))?;
            for value in urls.lines() {
                let Some(path) = local_remote(&repo.local_path, value)? else {
                    continue;
                };
                let canonical = std::fs::canonicalize(path)
                    .map_err(|_| rejected("Local Git remote cannot be inspected"))?;
                if !registry.is_authorized(&canonical) {
                    return Err(GitError::command("native Git refused", format!("Local Git remote {} is outside the authorized workspace. Open its folder in Oarlock and retry.", canonical.display())));
                }
                let remote =
                    owned_repo_root(registry, &canonical.to_string_lossy(), &WorkspaceEnv::Local)?;
                drop(remote);
            }
        }
    }
    Ok(())
}
