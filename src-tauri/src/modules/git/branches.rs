use crate::modules::git::errors::{GitError, Result};
use crate::modules::git::operations::sha_is_safe;
use crate::modules::git::process::{ensure_git_available, ensure_success};
use crate::modules::git::types::{GitBranchEntry, GitBranchListResult, DEFAULT_TIMEOUT_SECS};
use crate::modules::git::utils::{authorized_repo_root, owned_repo_root, validate_branch_name};
use crate::modules::git::worktree;
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

/// Undoes the newest commit the way `git reset --soft HEAD~1` does: the branch moves back to
/// the commit's first parent and its changes stay staged, so nothing is lost. `expected_head`
/// is the commit the user chose: the move compares the confirmed branch's tip,
/// so an intervening commit is not undone in its place. Oarlock's branch switches
/// share the worktree lock; changes by other processes remain best effort.
pub fn undo_last_commit(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    expected_head: &str,
    expected_branch: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    undo_last_commit_with_hook(registry, repo_root, expected_head, expected_branch, workspace, || {})
}

fn undo_last_commit_with_hook(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    expected_head: &str,
    expected_branch: &str,
    workspace: &WorkspaceEnv,
    after_head_check: impl FnOnce(),
) -> Result<()> {
    let repo_root = owned_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    crate::modules::fs::document_save::with_lock(&repo_root.local_path, || {
        if expected_head.len() != 40 || !sha_is_safe(expected_head) {
            return Err(GitError::command(
                "undo commit",
                "expected a full commit sha",
            ));
        }
        validate_branch_name(expected_branch)?;
        let expected_ref = format!("refs/heads/{expected_branch}");
        if repo_root
            .line(["symbolic-ref", "--quiet", "--no-recurse", "HEAD"])?
            .as_deref()
            != Some(expected_ref.as_str())
        {
            return Err(GitError::command(
                "undo commit",
                "The checked-out branch changed since confirmation; refresh and try again",
            ));
        }
        after_head_check();
        // The worktree lock serializes Oarlock checkouts with this check and update.
        // Always name the confirmed ref so an external checkout cannot redirect the
        // update to a different branch; external races remain best effort.
        // The parent comes from the chosen commit, not from HEAD, so a racing commit cannot
        // change which commit is undone.
        let parent = repo_root
            .line([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{expected_head}^"),
            ])?
            .ok_or_else(|| GitError::command("undo commit", "the first commit cannot be undone"))?;
        let output = repo_root.run(
            [
                "update-ref",
                "-m",
                "reset: moving to HEAD~1",
                "--no-deref",
                expected_ref.as_str(),
                &parent,
                expected_head,
            ],
            DEFAULT_TIMEOUT_SECS,
        )?;
        if output.timed_out || output.exit_code != Some(0) {
            return Err(GitError::command(
                "undo commit",
                "HEAD moved since the history was loaded; refresh and try again",
            ));
        }
        // As `git reset` does; it is also what tells Source Control's watcher HEAD moved.
        let _ = repo_root.run(
            ["update-ref", "ORIG_HEAD", expected_head],
            DEFAULT_TIMEOUT_SECS,
        );
        Ok(())
    })
}

/// The first remote-tracking branch that already contains `sha`, if any: undoing such a commit
/// rewrites history that was shared.
pub fn commit_on_remote(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<Option<String>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command(
            "git for-each-ref",
            "invalid commit identifier",
        ));
    }
    let contains = format!("--contains={sha}");
    let output = repo_root.run(
        [
            "for-each-ref",
            "--count=1",
            contains.as_str(),
            "--format=%(refname:short)",
            "refs/remotes",
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git for-each-ref failed")?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!name.is_empty()).then_some(name))
}

pub fn list_branches(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitBranchListResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;

    let current_branch = repo_root
        .line(["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .flatten();
    let is_detached_head = current_branch.as_deref() == Some("HEAD");
    let worktrees = worktree::list_worktrees(registry, &repo_root)?;

    let mut branches: Vec<GitBranchEntry> = Vec::new();
    let listed = repo_root.run(
        ["branch", "--format=%(refname:short)%00%(HEAD)"],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&listed, "git branch failed")?;
    if listed.truncated {
        return Err(GitError::command(
            "git branch",
            "branch list exceeds the output limit",
        ));
    }
    let lines = std::str::from_utf8(&listed.stdout)
        .map_err(|_| GitError::command("git branch", "cannot decode branch list"))?;
    for line in lines.lines() {
        let mut parts = line.split('\0');
        let name = parts.next().unwrap_or("").to_string();
        let is_head = parts.next().unwrap_or("") == "*";
        if name.is_empty() {
            continue;
        }
        let worktree_path = worktrees
            .iter()
            .find(|wt| !wt.is_current && wt.branch.as_deref() == Some(name.as_str()))
            .map(|wt| wt.path.clone());
        branches.push(GitBranchEntry {
            name,
            worktree_path,
            is_head,
            is_detached: is_head && is_detached_head,
        });
    }
    branches.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(GitBranchListResult {
        branches,
        worktrees,
    })
}

pub fn checkout_branch(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    branch_name: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = owned_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    crate::modules::fs::document_save::with_lock(&repo_root.local_path, || {
        validate_branch_name(branch_name)?;
        // `git checkout <name>` falls back to restoring a file of that name when no such branch
        // exists (one deleted since the list was loaded), discarding its changes. `switch` only
        // ever switches branches.
        let output = repo_root.run(["switch", branch_name], DEFAULT_TIMEOUT_SECS)?;
        ensure_success(&output, "git switch failed")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn git(dir: &Path, args: &[&str]) -> bool {
        std::process::Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .is_ok_and(|o| o.status.success())
    }

    #[test]
    fn branch_list_reports_corrupt_refs_instead_of_an_empty_list() {
        let repo = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(repo.path()).unwrap();
        assert!(git(&root, &["init", "-q"]));
        assert!(git(&root, &["commit", "-q", "--allow-empty", "-m", "init"]));
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        let root_path = root.to_string_lossy().to_string();
        assert!(list_branches(&registry, &root_path, &WorkspaceEnv::Local).is_ok());
        std::fs::write(root.join(".git/packed-refs"), "not a ref\n").unwrap();
        assert!(list_branches(&registry, &root_path, &WorkspaceEnv::Local).is_err());
    }

    #[test]
    fn undo_and_branch_switch_do_not_cross_after_confirmation() {
        use std::{sync::mpsc, time::Duration};
        let repo = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(repo.path()).unwrap();
        assert!(git(&root, &["init", "-q", "-b", "main"]));
        std::fs::write(root.join("file"), "one\n").unwrap();
        assert!(git(&root, &["add", "file"]));
        assert!(git(&root, &["commit", "-q", "-m", "one"]));
        std::fs::write(root.join("file"), "two\n").unwrap();
        assert!(git(&root, &["commit", "-q", "-a", "-m", "two"]));
        assert!(git(&root, &["branch", "other"]));
        let head = std::process::Command::new("git").args(["rev-parse", "HEAD"]).current_dir(&root).output().unwrap();
        assert!(head.status.success());
        let head = String::from_utf8(head.stdout).unwrap().trim().to_string();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        let path = root.to_string_lossy().to_string();
        #[cfg(unix)]
        let alias = {
            let parent = tempfile::tempdir().unwrap();
            let link = parent.path().join("alias");
            std::os::unix::fs::symlink(&root, &link).unwrap();
            (parent, link.to_string_lossy().to_string())
        };
        #[cfg(unix)]
        let switch_path = &alias.1;
        #[cfg(not(unix))]
        let switch_path = &path;
        let (checked_tx, checked_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let (switch_tx, switch_rx) = mpsc::channel();
        std::thread::scope(|scope| {
            let undo_registry = &registry;
            let undo_path = &path;
            let undo_head = &head;
            let undo = scope.spawn(move || undo_last_commit_with_hook(undo_registry, undo_path, undo_head, "main", &WorkspaceEnv::Local, || {
                checked_tx.send(()).unwrap();
                resume_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            }));
            checked_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            scope.spawn(|| { switch_tx.send(checkout_branch(&registry, switch_path, "other", &WorkspaceEnv::Local)).unwrap(); });
            let early = switch_rx.recv_timeout(Duration::from_secs(2)).ok();
            resume_tx.send(()).unwrap();
            let undo = undo.join().unwrap();
            let switched_early = early.is_some();
            let switch = early.unwrap_or_else(|| switch_rx.recv_timeout(Duration::from_secs(10)).unwrap());
            assert!(switch.is_ok(), "switch failed: {switch:?}");
            assert!(!switched_early || undo.is_err(), "undo succeeded after another window switched branches");
            if !switched_early { assert!(undo.is_ok(), "undo failed: {undo:?}"); }
        });
    }

    #[test]
    fn branches_list_where_another_worktree_has_them_checked_out() {
        let dir = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(dir.path()).unwrap();
        let root = base.join("app");
        std::fs::create_dir(&root).unwrap();
        if !git(&root, &["init", "-q", "-b", "main"]) {
            return;
        }
        assert!(git(&root, &["commit", "-q", "--allow-empty", "-m", "init"]));
        assert!(git(&root, &["branch", "free"]));
        let root_path = crate::modules::git::utils::display_path(&root);
        let linked_path = crate::modules::git::utils::display_path(&base.join("app-feat"));
        assert!(git(
            &root,
            &["worktree", "add", "-q", "-b", "feat", &linked_path]
        ));
        let registry = WorkspaceRegistry::default();
        registry.authorize(&base).unwrap();
        let local = WorkspaceEnv::Local;

        let listed = list_branches(&registry, &root_path, &local).unwrap();
        let summary: Vec<(&str, Option<&str>, bool)> = listed
            .branches
            .iter()
            .map(|b| (b.name.as_str(), b.worktree_path.as_deref(), b.is_head))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("feat", Some(linked_path.as_str()), false),
                ("free", None, false),
                ("main", None, true),
            ]
        );
        assert_eq!(listed.worktrees.len(), 2);
        assert!(listed.worktrees[0].is_current && listed.worktrees[0].is_main);

        // From the linked worktree, `main` is the one checked out elsewhere.
        let listed = list_branches(&registry, &linked_path, &local).unwrap();
        let main = listed.branches.iter().find(|b| b.name == "main").unwrap();
        assert_eq!(main.worktree_path.as_deref(), Some(root_path.as_str()));
        let feat = listed.branches.iter().find(|b| b.name == "feat").unwrap();
        assert!(feat.is_head && feat.worktree_path.is_none());
        assert!(listed.worktrees[1].is_current);
    }

    #[test]
    fn checkout_refuses_names_git_would_read_otherwise() {
        let repo = tempfile::tempdir().unwrap();
        let root = repo.path();
        if !git(root, &["init", "-q"]) {
            return;
        }
        let registry = WorkspaceRegistry::default();
        registry.authorize(root).unwrap();
        for name in ["-f", "--orphan=x", "", "a..b", "HEAD"] {
            let err = checkout_branch(
                &registry,
                &root.to_string_lossy(),
                name,
                &WorkspaceEnv::Local,
            )
            .unwrap_err();
            assert!(
                matches!(err, GitError::InvalidBranchName(_)),
                "{name:?}: {err}"
            );
        }
    }

}
