//! AI content must come from the exact trees whose paths passed the secret policy.
use super::errors::{GitError, Result};
use super::process::{ensure_git_available, ensure_success};
use super::types::DEFAULT_TIMEOUT_SECS;
use super::utils::{owned_repo_root, resolve_within_repo, ResolvedGitDirectory};
use crate::modules::{
    secret_paths,
    workspace::{WorkspaceEnv, WorkspaceRegistry},
};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStagedDiff {
    pub paths: Vec<String>,
    pub diff_text: String,
    pub truncated: bool,
}

fn checked_output(repo: &ResolvedGitDirectory, args: &[&str]) -> Result<super::types::GitOutput> {
    let output = repo.run(
        std::iter::once("--no-replace-objects").chain(args.iter().copied()),
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "read staged changes for AI")?;
    Ok(output)
}

fn object_id(repo: &ResolvedGitDirectory, args: &[&str]) -> Result<String> {
    let output = checked_output(repo, args)?;
    let id = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if output.truncated
        || !matches!(id.len(), 40 | 64)
        || !id.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(GitError::command(
            "read staged changes for AI",
            "invalid Git object ID",
        ));
    }
    Ok(id)
}

pub fn staged_diff(
    registry: &WorkspaceRegistry,
    root: &str,
    workspace: &WorkspaceEnv,
) -> Result<AiStagedDiff> {
    let repo = owned_repo_root(registry, root, workspace)?;
    ensure_git_available(workspace)?;
    // write-tree captures the index atomically, including unborn branches. No hooks run.
    let staged = object_id(&repo, &["write-tree"])?;
    let head = repo.run(
        [
            "--no-replace-objects",
            "rev-parse",
            "--verify",
            "HEAD^{tree}",
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    let base = if head.exit_code == Some(0) && !head.timed_out {
        let id = String::from_utf8_lossy(&head.stdout).trim().to_owned();
        if head.truncated
            || !matches!(id.len(), 40 | 64)
            || !id.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(GitError::command(
                "read staged changes for AI",
                "invalid HEAD tree",
            ));
        }
        id
    } else {
        // Only an unborn branch may use an empty base; a damaged HEAD must fail closed.
        let branch = checked_output(&repo, &["symbolic-ref", "HEAD"])?;
        let branch = String::from_utf8_lossy(&branch.stdout).trim().to_owned();
        let exists = repo.run(
            ["show-ref", "--verify", "--quiet", &branch],
            DEFAULT_TIMEOUT_SECS,
        )?;
        if exists.timed_out || exists.exit_code != Some(1) {
            return Err(GitError::command(
                "read staged changes for AI",
                "cannot resolve HEAD",
            ));
        }
        // stdin is /dev/null (also on Windows); Git chooses the repository's hash format.
        object_id(&repo, &["hash-object", "-w", "-t", "tree", "--stdin"])?
    };
    diff_trees(&repo, &base, &staged)
}

fn diff_trees(repo: &ResolvedGitDirectory, base: &str, staged: &str) -> Result<AiStagedDiff> {
    // Disabling renames exposes BOTH names as delete/add and prevents copy detection
    // from pulling snippets from unrelated, protected historical paths.
    let names = checked_output(
        repo,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--name-only",
            "-z",
            base,
            staged,
            "--",
        ],
    )?;
    if names.truncated {
        return Err(GitError::command(
            "read staged changes for AI",
            "too many staged paths to validate",
        ));
    }
    let paths = validate_paths(repo, &names.stdout)?;
    let patch = checked_output(
        repo,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--submodule=short",
            "--no-color",
            base,
            staged,
            "--",
        ],
    )?;
    Ok(AiStagedDiff {
        paths,
        diff_text: String::from_utf8_lossy(&patch.stdout).into_owned(),
        truncated: patch.truncated,
    })
}

fn validate_paths(repo: &ResolvedGitDirectory, bytes: &[u8]) -> Result<Vec<String>> {
    if !bytes.is_empty() && bytes.last() != Some(&0) {
        return Err(GitError::command(
            "read staged changes for AI",
            "incomplete staged path list",
        ));
    }
    bytes
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|path| {
            let path = std::str::from_utf8(path).map_err(|_| {
                GitError::command(
                    "read staged changes for AI",
                    "cannot validate a non-UTF-8 path",
                )
            })?;
            let lexical = repo.local_path.join(path);
            if !secret_paths::readable(&lexical)
                || !secret_paths::readable(&resolve_within_repo(&repo.local_path, path)?)
            {
                return Err(GitError::command(
                    "AI commit-message generation refused",
                    format!("staged changes include a protected path: {path}"),
                ));
            }
            Ok(path.to_owned())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn changing_index_and_head_cannot_change_the_validated_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .current_dir(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "Test"]);
        git(&["config", "user.email", "test@oarlock.local"]);
        git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("safe.txt"), "old\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "initial"]);
        let base = git(&["rev-parse", "HEAD^{tree}"]);
        std::fs::write(root.join("safe.txt"), "staged\n").unwrap();
        git(&["add", "."]);
        let staged = git(&["write-tree"]);
        std::fs::write(root.join(".env"), "SYNTHETIC_LATE_SECRET\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "concurrent commit"]);
        let replacement = git(&["rev-parse", "HEAD^{tree}"]);
        git(&["replace", &staged, &replacement]);
        let repo = ResolvedGitDirectory {
            ownership: None,
            workspace: WorkspaceEnv::Local,
            git_path: root.to_string_lossy().into_owned(),
            local_path: root,
        };
        let result = diff_trees(&repo, &base, &staged).unwrap();
        assert_eq!(result.paths, ["safe.txt"]);
        assert!(result.diff_text.contains("+staged"));
        assert!(!result.diff_text.contains("SYNTHETIC_LATE_SECRET"));
    }

    #[test]
    fn invalid_or_incomplete_path_lists_fail_closed() {
        let repo = ResolvedGitDirectory {
            ownership: None,
            workspace: WorkspaceEnv::Local,
            git_path: String::new(),
            local_path: std::env::temp_dir(),
        };
        for paths in [
            b"safe.txt".as_slice(),
            b"invalid\xff\0",
            b"../outside\0",
            b".ssh/config\0",
            b".env\0",
            b"line\nname\0",
        ] {
            assert!(validate_paths(&repo, paths).is_err(), "{paths:?}");
        }
    }
}
