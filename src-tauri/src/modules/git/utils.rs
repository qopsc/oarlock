use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::modules::git::errors::{GitError, Result};
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

#[derive(Clone, Debug)]
pub struct ResolvedGitDirectory {
    pub workspace: WorkspaceEnv,
    pub git_path: String,
    pub local_path: PathBuf,
    pub(crate) ownership: Option<std::sync::Arc<super::ownership::RepositoryPin>>,
}

impl ResolvedGitDirectory {
    pub(crate) fn run<I, S>(&self, args: I, timeout: u64) -> Result<super::types::GitOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        super::process::run_git_in(self, args, timeout)
    }
    pub(crate) fn line<I, S>(&self, args: I) -> Result<Option<String>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = self.run(args, super::types::DEFAULT_TIMEOUT_SECS)?;
        if output.timed_out {
            return Err(GitError::TimedOut("git command"));
        }
        if output.exit_code != Some(0) {
            return Ok(None);
        }
        let line = std::str::from_utf8(&output.stdout)
            .unwrap_or("")
            .lines()
            .next()
            .unwrap_or("")
            .trim();
        Ok((!line.is_empty()).then(|| line.to_string()))
    }
    pub(crate) fn lines<I, S>(&self, args: I) -> Result<Vec<String>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = self.run(args, super::types::DEFAULT_TIMEOUT_SECS)?;
        if output.timed_out {
            return Err(GitError::TimedOut("git command"));
        }
        if output.exit_code != Some(0) {
            return Ok(vec![]);
        }
        Ok(std::str::from_utf8(&output.stdout)
            .unwrap_or("")
            .lines()
            .map(|line| line.trim_end_matches('\r').to_string())
            .collect())
    }
}
/// Mutation callers retain this object across every preflight and command batch.
pub(crate) fn owned_repo_root(
    registry: &WorkspaceRegistry,
    path: &str,
    workspace: &WorkspaceEnv,
) -> Result<ResolvedGitDirectory> {
    let requested = resolve_path(path, workspace).map_err(|e| GitError::command("workspace", e))?;
    let directory = super::ownership::DirectoryPin::acquire(&requested, workspace)?;
    if !registry.is_authorized(directory.path()) {
        return Err(GitError::PathOutsideWorkspace(directory.path().into()));
    }
    let pin = super::ownership::RepositoryPin::acquire(directory, workspace, registry)?;
    if !registry.is_authorized(pin.path()) {
        return Err(GitError::PathOutsideWorkspace(pin.path().into()));
    }
    let repo = ResolvedGitDirectory {
        workspace: workspace.clone(),
        git_path: display_path(pin.path()),
        local_path: pin.path().into(),
        ownership: Some(std::sync::Arc::new(pin)),
    };
    super::commit_guard::preflight(&repo)?;
    Ok(repo)
}

pub fn split_upstream(upstream: &str) -> (Option<String>, Option<String>) {
    match upstream.split_once('/') {
        Some((remote, branch)) => (Some(remote.to_string()), Some(branch.to_string())),
        None => (None, Some(upstream.to_string())),
    }
}

pub fn display_path(path: &Path) -> String {
    crate::modules::fs::to_canon(path)
}

fn normalize_git_path(path: &str) -> String {
    path.replace('\\', "/")
}

pub fn canonical_dir(
    registry: &WorkspaceRegistry,
    path: &str,
    workspace: &WorkspaceEnv,
) -> Result<ResolvedGitDirectory> {
    let candidate =
        resolve_path(path, workspace).map_err(|error| GitError::command("workspace", error))?;
    if !candidate.is_dir() {
        return Err(GitError::NotADirectory(path.to_string()));
    }
    let local_path = registry
        .canonicalize_cached(&candidate)
        .map_err(GitError::Io)?;
    let git_path = if workspace.is_wsl() {
        normalize_git_path(path)
    } else {
        display_path(&local_path)
    };
    Ok(ResolvedGitDirectory {
        workspace: workspace.clone(),
        git_path,
        local_path,
        ownership: None,
    })
}

pub fn authorized_repo_root(
    registry: &WorkspaceRegistry,
    path: &str,
    workspace: &WorkspaceEnv,
) -> Result<ResolvedGitDirectory> {
    let canonical = canonical_dir(registry, path, workspace)?;
    if !registry.is_authorized(&canonical.local_path) {
        return Err(GitError::PathOutsideWorkspace(canonical.local_path.clone()));
    }
    super::ownership::authorize_repository_metadata(registry, &canonical.local_path)?;
    if workspace.is_wsl() {
        super::commit_guard::preflight(&canonical)?;
        Ok(canonical)
    } else {
        owned_repo_root(registry, path, workspace)
    }
}

pub fn resolve_within_repo(repo_root: &Path, rel: &str) -> Result<PathBuf> {
    if !is_safe_pathspec(rel) {
        return Err(GitError::InvalidPath(rel.into()));
    }
    let joined = repo_root.join(rel);
    match std::fs::canonicalize(&joined) {
        Ok(canonical) => {
            if !canonical.starts_with(repo_root) {
                return Err(GitError::PathOutsideWorkspace(canonical));
            }
            Ok(canonical)
        }
        // Deleted path (staging a removal): validate via nearest existing ancestor.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            resolve_deleted_within_repo(repo_root, &joined, rel)
        }
        Err(e) => Err(GitError::Io(e)),
    }
}

/// Git names directory entries, not the filesystem objects their symlinks target.
/// Historical entries need only lexical validation; they need not exist today.
pub fn git_entry_name(rel: &str) -> Result<String> {
    if !is_safe_pathspec(rel) || rel.starts_with(['/', '\\']) || Path::new(rel).is_absolute() {
        return Err(GitError::InvalidPath(rel.into()));
    }
    #[cfg(windows)]
    let rel = rel.replace('\\', "/");
    // Status reports collapsed untracked directories with a trailing slash.
    let rel = rel.trim_end_matches('/');
    if rel.split('/').any(str::is_empty) {
        return Err(GitError::InvalidPath(rel.into()));
    }
    Ok(rel.to_string())
}

/// Keep the leaf itself intact, including dangling/out-of-tree symlinks. Never
/// traverse a symlink ancestor: Git also refuses pathspecs beyond a symlink.
pub fn git_worktree_entry(repo_root: &Path, rel: &str) -> Result<PathBuf> {
    let rel = git_entry_name(rel)?;
    let mut parent = repo_root.to_path_buf();
    let parts: Vec<_> = rel.split('/').collect();
    for part in &parts[..parts.len() - 1] {
        parent.push(part);
        match std::fs::symlink_metadata(&parent) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(GitError::SymlinkRejected(parent));
            }
            Ok(meta) if !meta.is_dir() => return Err(GitError::InvalidPath(rel)),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(repo_root.join(rel))
}

/// A branch name git accepts (`git check-ref-format --branch`, which also refuses a leading
/// `-`, so a name is never read as an option), except `@`, which revisions read as HEAD.
/// Every command that takes a branch name (switching, new worktrees) checks it.
pub fn validate_branch_name(name: &str) -> Result<()> {
    if is_valid_branch_name(name) {
        Ok(())
    } else {
        Err(GitError::InvalidBranchName(name.into()))
    }
}

fn is_valid_branch_name(name: &str) -> bool {
    if name.is_empty() || name.starts_with('-') || name == "HEAD" || name == "@" {
        return false;
    }
    if name.ends_with('.') || name.contains("..") || name.contains("@{") {
        return false;
    }
    if name.chars().any(|c| {
        c.is_ascii_control() || matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\')
    }) {
        return false;
    }
    // No empty component (a leading, trailing or doubled `/`), none hidden, none a lock file.
    name.split('/')
        .all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock"))
}

pub fn is_safe_pathspec(rel: &str) -> bool {
    if rel.is_empty() || rel.contains(':') || rel.contains('\0') {
        return false;
    }
    if rel.chars().any(|c| (c as u32) < 0x20) {
        return false;
    }
    // Reject `.`/`..` so the deleted-path branch can't be used to escape the repo.
    !rel.split(['/', '\\']).any(|c| c == "." || c == "..")
}

fn resolve_deleted_within_repo(repo_root: &Path, joined: &Path, rel: &str) -> Result<PathBuf> {
    let mut tail: Vec<&OsStr> = Vec::new();
    let mut cursor = joined;
    loop {
        let name = cursor
            .file_name()
            .ok_or_else(|| GitError::InvalidPath(rel.into()))?;
        let parent = cursor
            .parent()
            .ok_or_else(|| GitError::InvalidPath(rel.into()))?;
        tail.push(name);
        match std::fs::canonicalize(parent) {
            Ok(canonical_parent) => {
                if !canonical_parent.starts_with(repo_root) {
                    return Err(GitError::PathOutsideWorkspace(canonical_parent));
                }
                let mut resolved = canonical_parent;
                for component in tail.iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                cursor = parent;
            }
            Err(e) => return Err(GitError::Io(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_upstream_separates_remote_and_branch() {
        assert_eq!(
            split_upstream("origin/main"),
            (Some("origin".to_string()), Some("main".to_string()))
        );
    }

    #[test]
    fn split_upstream_splits_on_the_first_slash_only() {
        assert_eq!(
            split_upstream("origin/feature/x"),
            (Some("origin".to_string()), Some("feature/x".to_string()))
        );
    }

    #[test]
    fn split_upstream_without_slash_yields_branch_only() {
        assert_eq!(split_upstream("main"), (None, Some("main".to_string())));
    }

    #[test]
    fn normalize_git_path_converts_backslashes_to_slashes() {
        assert_eq!(normalize_git_path("a\\b\\c"), "a/b/c");
        assert_eq!(normalize_git_path("a/b"), "a/b");
    }

    #[test]
    fn safe_pathspec_accepts_normal_paths() {
        assert!(is_safe_pathspec("src/main.rs"));
        assert!(is_safe_pathspec("a/b/c-d_e.txt"));
        assert!(is_safe_pathspec("folder with spaces/file.md"));
        assert!(is_safe_pathspec("file.with.dots"));
    }

    #[test]
    fn safe_pathspec_rejects_colon() {
        assert!(!is_safe_pathspec("evil:path"));
        assert!(!is_safe_pathspec(":head"));
        assert!(!is_safe_pathspec("a/b:c"));
    }

    #[test]
    fn safe_pathspec_rejects_nul_and_control() {
        assert!(!is_safe_pathspec("foo\0bar"));
        assert!(!is_safe_pathspec("foo\nbar"));
        assert!(!is_safe_pathspec("foo\rbar"));
        assert!(!is_safe_pathspec("foo\tbar"));
    }

    #[test]
    fn safe_pathspec_rejects_empty() {
        assert!(!is_safe_pathspec(""));
    }

    #[test]
    fn resolve_within_repo_rejects_colon_path() {
        let tmp = std::env::temp_dir();
        let err = resolve_within_repo(&tmp, "evil:path");
        assert!(matches!(err, Err(GitError::InvalidPath(_))));
    }

    #[test]
    fn resolve_within_repo_rejects_nul_path() {
        let tmp = std::env::temp_dir();
        let err = resolve_within_repo(&tmp, "evil\0path");
        assert!(matches!(err, Err(GitError::InvalidPath(_))));
    }

    #[test]
    fn safe_pathspec_rejects_dot_components() {
        assert!(!is_safe_pathspec("../escape"));
        assert!(!is_safe_pathspec("a/../b"));
        assert!(!is_safe_pathspec("./a"));
        assert!(!is_safe_pathspec("a/."));
        assert!(!is_safe_pathspec(".."));
    }

    #[test]
    fn resolve_within_repo_handles_deleted_directory() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        std::fs::create_dir_all(base.join("envs/__pycache__")).unwrap();
        let repo_root = std::fs::canonicalize(base).unwrap();
        std::fs::remove_dir_all(repo_root.join("envs")).unwrap();
        let resolved =
            resolve_within_repo(&repo_root, "envs/__pycache__/g1.pyc").expect("deleted path");
        assert_eq!(resolved, repo_root.join("envs/__pycache__/g1.pyc"));
    }

    #[test]
    fn branch_names_follow_git_check_ref_format() {
        for name in [
            "main",
            "feature/login",
            "fix-1.2",
            "release_2026",
            "größe",
            "a.b/c-d",
            "a-",
            "HEADS",
            "x@y",
        ] {
            assert!(validate_branch_name(name).is_ok(), "{name:?} is valid");
        }
        for name in [
            "", "-b", "--force", "HEAD", "@", "a b", "a\tb", "a\u{7f}b", "a~1", "a^", "a:b", "a?",
            "a*", "a[b", "a\\b", "a..b", "a@{1}", "a.", "/a", "a/", "a//b", ".a", "a/.b", "a.lock",
            "a.lock/b",
        ] {
            assert!(
                matches!(
                    validate_branch_name(name),
                    Err(GitError::InvalidBranchName(_))
                ),
                "{name:?} is invalid"
            );
        }
    }

    #[test]
    fn the_branch_rule_agrees_with_git() {
        let git_accepts = |name: &str| {
            std::process::Command::new("git")
                .args(["check-ref-format", "--branch", name])
                .output()
                .map(|o| o.status.success())
        };
        if git_accepts("main").is_err() {
            return;
        }
        for name in [
            "main", "a/b", "größe", "x@y", "a..b", "a.lock", ".a", "a/", "a//b", "a b", "a~", "a.",
            "a@{1}", "a\\b", "a:b", "a?", "a[b", "HEAD", "-b",
        ] {
            assert_eq!(
                git_accepts(name).unwrap(),
                validate_branch_name(name).is_ok(),
                "{name:?}"
            );
        }
    }

    #[test]
    fn resolve_within_repo_rejects_deleted_escape() {
        let tmp = std::env::temp_dir();
        let err = resolve_within_repo(&tmp, "../outside.txt");
        assert!(matches!(err, Err(GitError::InvalidPath(_))));
    }
}
