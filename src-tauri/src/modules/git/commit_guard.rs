//! Best-effort admission for the existing live commit path. Repository config
//! is inspected before invocation; another local process can change it later.
use super::{
    candidate_policy::parse_config,
    errors::{GitError, Result},
    types::DEFAULT_TIMEOUT_SECS,
    utils::ResolvedGitDirectory,
};

fn refused(setting: &str) -> GitError {
    GitError::command(
        "native Git refused",
        format!("{setting} can run an external program. Run this Git operation in the terminal, or remove the setting and retry."),
    )
}

fn enabled(value: Option<&str>) -> bool {
    !matches!(value, Some(v) if v.is_empty() || v == "0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("no") || v.eq_ignore_ascii_case("off"))
}

fn external_transport(value: &str) -> bool {
    let value = value.trim();
    if let Some((helper, _)) = value.split_once("::") {
        if !helper.is_empty()
            && helper
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
        {
            return true;
        }
    }
    if let Some((scheme, _)) = value.split_once("://") {
        return !matches!(
            scheme.to_ascii_lowercase().as_str(),
            "https" | "http" | "ssh" | "git" | "file"
        );
    }
    false
}

fn executable_setting(
    key: &str,
    value: Option<&str>,
    repository_scope: bool,
) -> Option<&'static str> {
    let (section, tail) = key.split_once('.')?;
    let section = section.to_ascii_lowercase();
    let variable = tail.rsplit('.').next().unwrap_or(tail).to_ascii_lowercase();
    let simple = !tail.contains('.');
    match (section.as_str(), variable.as_str()) {
        ("hook", _) => Some("Git hook configuration"),
        ("core", "hookspath") if simple => Some("core.hooksPath"),
        ("core", "fsmonitor") if simple && enabled(value) => Some("core.fsmonitor"),
        ("core", "gitproxy") if simple => Some("core.gitProxy"),
        ("filter", "clean" | "smudge" | "process") => Some("a Git filter driver"),
        ("diff", "external" | "command" | "textconv") => Some("a Git diff driver"),
        ("merge", "driver") => Some("a Git merge driver"),
        ("commit", "gpgsign") if simple && enabled(value) => Some("commit.gpgSign"),
        ("gpg", "program" | "defaultkeycommand") => Some("a Git signing program"),
        ("credential", "helper") if repository_scope => Some("credential.helper"),
        ("core", "sshcommand") if simple && repository_scope => Some("core.sshCommand"),
        ("core", "askpass") if simple && repository_scope => Some("core.askPass"),
        ("core", "editor") if simple && repository_scope => Some("core.editor"),
        ("core", "pager") if simple && repository_scope => Some("core.pager"),
        ("sequence", "editor") if simple && repository_scope => Some("sequence.editor"),
        ("trailer", "cmd" | "command") if repository_scope => Some("a Git trailer command"),
        ("interactive", "difffilter") if simple && repository_scope => {
            Some("interactive.diffFilter")
        }
        ("core", "alternaterefscommand") if simple && repository_scope => {
            Some("core.alternateRefsCommand")
        }
        ("gc", "recentobjectshook") | ("uploadpack", "packobjectshook") if repository_scope => {
            Some("a Git object-processing hook")
        }
        ("remote", "uploadpack" | "receivepack") if repository_scope => {
            Some("a remote Git command")
        }
        ("remote", "url" | "pushurl")
            if repository_scope && value.is_some_and(external_transport) =>
        {
            Some("an external Git transport")
        }
        ("protocol", "allow")
            if repository_scope
                && (simple
                    || tail
                        .rsplit_once('.')
                        .is_some_and(|(protocol, _)| protocol.eq_ignore_ascii_case("ext")))
                && value.is_some_and(|v| {
                    v.eq_ignore_ascii_case("always") || v.eq_ignore_ascii_case("user")
                }) =>
        {
            Some("an external Git transport policy")
        }
        ("url", "insteadof" | "pushinsteadof")
            if tail
                .rsplit_once('.')
                .is_some_and(|(base, _)| external_transport(base)) =>
        {
            Some("an external Git transport rewrite")
        }
        ("remote", "vcs" | "partialclonefilter") => Some("a Git remote helper or partial clone"),
        ("remote", "promisor") if enabled(value) => Some("a Git remote helper or partial clone"),
        ("extensions", "partialclone") if simple && repository_scope => Some("a Git partial clone"),
        _ => None,
    }
}

fn inspect_config(repo: &ResolvedGitDirectory, scope: Option<&str>) -> Result<bool> {
    let mut args = vec!["config", "--includes", "--null", "--list"];
    if let Some(scope) = scope {
        args.push(scope);
    }
    let output = repo.run(args, DEFAULT_TIMEOUT_SECS)?;
    if output.timed_out || output.truncated || output.exit_code != Some(0) {
        return Err(GitError::command(
            "native Git refused",
            "Git configuration could not be checked completely",
        ));
    }
    let records = parse_config(&output.stdout).map_err(|_| {
        GitError::command(
            "native Git refused",
            "Git configuration is unreadable or exceeds the inspection limit",
        )
    })?;
    let mut worktree_config = false;
    for (key, value) in records {
        if let Some(setting) = executable_setting(key, value, scope.is_some()) {
            return Err(refused(setting));
        }
        if key.eq_ignore_ascii_case("extensions.worktreeconfig") {
            worktree_config = match value {
                None => true,
                Some(v)
                    if v.is_empty()
                        || v == "0"
                        || v.eq_ignore_ascii_case("false")
                        || v.eq_ignore_ascii_case("no")
                        || v.eq_ignore_ascii_case("off") =>
                {
                    false
                }
                Some(v)
                    if v == "1"
                        || v.eq_ignore_ascii_case("true")
                        || v.eq_ignore_ascii_case("yes")
                        || v.eq_ignore_ascii_case("on") =>
                {
                    true
                }
                _ => {
                    return Err(GitError::command(
                        "native Git refused",
                        "Invalid worktree configuration setting",
                    ))
                }
            };
        }
    }
    Ok(worktree_config)
}

fn inspect_repo_origins(repo: &ResolvedGitDirectory) -> Result<()> {
    // A user-wide includeIf can load a file from the repository while Git
    // still reports it in global scope. Treat that file as repository data.
    let output = repo.run(
        ["config", "--includes", "--null", "--list", "--show-origin"],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.timed_out
        || output.truncated
        || output.exit_code != Some(0)
        || output.stdout.len() > 256 * 1024
        || (!output.stdout.is_empty() && !output.stdout.ends_with(&[0]))
    {
        return Err(GitError::command(
            "native Git refused",
            "Git configuration origins could not be checked completely",
        ));
    }
    let parts: Vec<_> = if output.stdout.is_empty() {
        Vec::new()
    } else {
        output.stdout[..output.stdout.len() - 1]
            .split(|b| *b == 0)
            .collect()
    };
    if parts.len() % 2 != 0 || parts.len() > 8192 {
        return Err(GitError::command(
            "native Git refused",
            "Git configuration origins are malformed",
        ));
    }
    for pair in parts.as_chunks::<2>().0 {
        let origin = std::str::from_utf8(pair[0]).map_err(|_| {
            GitError::command(
                "native Git refused",
                "Git configuration origin is unreadable",
            )
        })?;
        let inside = origin.strip_prefix("file:").is_some_and(|path| {
            let raw = path;
            let path = std::path::Path::new(raw);
            let candidate = if repo.workspace.is_wsl() && raw.starts_with('/') {
                let Ok(resolved) = crate::modules::workspace::resolve_path(raw, &repo.workspace)
                else {
                    return true;
                };
                resolved
            } else if path.is_absolute() {
                path.to_path_buf()
            } else {
                repo.local_path.join(path)
            };
            candidate.starts_with(&repo.local_path)
                || std::fs::canonicalize(&candidate).is_ok_and(|p| p.starts_with(&repo.local_path))
        });
        let mut record = pair[1].to_vec();
        record.push(0);
        let parsed = parse_config(&record).map_err(|_| {
            GitError::command("native Git refused", "Git configuration is unreadable")
        })?;
        for (key, value) in parsed {
            if let Some(setting) = executable_setting(key, value, inside) {
                return Err(refused(setting));
            }
        }
    }
    Ok(())
}

fn inspect_hooks(repo: &ResolvedGitDirectory) -> Result<()> {
    let path = match &repo.ownership {
        Some(owner) => owner.hooks_path(),
        None if repo.workspace.is_wsl() => {
            super::ownership::unowned_metadata_paths(&repo.local_path)?
                .1
                .join("hooks")
        }
        None => {
            return Err(GitError::command(
                "native Git refused",
                "Repository ownership is missing",
            ))
        }
    };
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(refused("a symbolic-link Git hooks directory"))
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => {
            return Err(GitError::command(
                "native Git refused",
                "Git hooks directory could not be inspected",
            ))
        }
    }
    let entries = match std::fs::read_dir(&path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => {
            return Err(GitError::command(
                "native Git refused",
                "Git hooks directory could not be inspected",
            ))
        }
    };
    for (count, entry) in entries.enumerate() {
        if count >= 4096 {
            return Err(GitError::command(
                "native Git refused",
                "Git hooks directory exceeds the inspection limit",
            ));
        }
        let entry = entry.map_err(|_| {
            GitError::command(
                "native Git refused",
                "Git hooks directory could not be inspected",
            )
        })?;
        // Git does not run the executable *.sample templates it installs.
        if entry.file_name().to_string_lossy().ends_with(".sample") {
            continue;
        }
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(|_| {
            GitError::command("native Git refused", "Git hook could not be inspected")
        })?;
        if metadata.file_type().is_symlink() {
            return Err(refused("a symbolic link in the Git hooks directory"));
        }
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = metadata.is_file();
        if executable {
            let name: String = entry
                .file_name()
                .to_string_lossy()
                .chars()
                .take(128)
                .collect();
            return Err(refused(&format!("executable Git hook {name:?}")));
        }
    }
    if let Some(owner) = &repo.ownership {
        owner.validate()?;
    }
    Ok(())
}

pub(super) fn preflight(repo: &ResolvedGitDirectory) -> Result<()> {
    // All effective hook/filter/signing settings may be activated by repository
    // content. Other executable settings are rejected when repo-configured;
    // ordinary user-wide credential helpers do not disable every local commit.
    if inspect_config(repo, Some("--local"))? {
        let path = match &repo.ownership {
            Some(owner) => owner.worktree_config_path(),
            None if repo.workspace.is_wsl() => {
                super::ownership::unowned_metadata_paths(&repo.local_path)?
                    .0
                    .join("config.worktree")
            }
            None => {
                return Err(GitError::command(
                    "native Git refused",
                    "Repository ownership is missing",
                ))
            }
        };
        match std::fs::symlink_metadata(path) {
            Ok(_) => {
                inspect_config(repo, Some("--worktree"))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(GitError::command(
                    "native Git refused",
                    "Git worktree configuration could not be checked",
                ))
            }
        }
    }
    inspect_repo_origins(repo)?;
    inspect_hooks(repo)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};
    use std::{os::unix::fs::PermissionsExt, process::Command};

    #[test]
    fn guarded_invocation_neutralizes_new_hooks_and_fsmonitor_after_preflight() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .current_dir(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git command failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "Oarlock Test"]);
        git(&["config", "user.email", "test@oarlock.local"]);
        git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("file"), "content").unwrap();
        git(&["add", "file"]);
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        let repo = super::super::utils::owned_repo_root(
            &registry,
            root.to_str().unwrap(),
            &WorkspaceEnv::Local,
        )
        .unwrap();
        preflight(&repo).unwrap();
        let hook = root.join(".git/injected-hook");
        std::fs::write(&hook, "#!/bin/sh\nprintf ran > .git/injected-marker\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
        git(&["config", "core.fsmonitor", hook.to_str().unwrap()]);
        git(&["config", "hook.inject.command", "sh .git/injected-hook"]);
        git(&["config", "hook.inject.event", "pre-commit"]);
        let result =
            super::super::process::run_guarded_commit(&repo, "test commit", DEFAULT_TIMEOUT_SECS)
                .unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert!(!root.join(".git/injected-marker").exists());
    }
}
