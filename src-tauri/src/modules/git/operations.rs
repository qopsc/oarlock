use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use crate::modules::git::errors::{GitError, Result};
use crate::modules::git::parser::{parse_decorations, parse_porcelain_v2};
use crate::modules::git::process::{
    decode_text, ensure_git_available, ensure_success, git_show_text, git_stdout_line_opt,
    git_stdout_lines, read_text_file, run_git_capped, run_git_guarded,
};
use crate::modules::git::types::{
    DiscardEntry, GitCommitFileChange, GitCommitResult,
    GitDiffContentResult, GitDiffResult, GitLogEntry, GitOutput, GitPanelSnapshot, GitPushResult,
    GitRepoInfo, GitStatusSnapshot, TextSource, COMMIT_TIMEOUT_SECS, DEFAULT_TIMEOUT_SECS,
    NETWORK_TIMEOUT_SECS,
};
use crate::modules::git::utils::{
    authorized_repo_root, canonical_dir, git_entry_name, git_worktree_entry, owned_repo_root,
    split_upstream, ResolvedGitDirectory,
};
use crate::modules::git::{untracked, worktree};
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

pub use super::branches::{checkout_branch, commit_on_remote, list_branches, undo_last_commit};

pub fn resolve_repo(
    registry: &WorkspaceRegistry,
    cwd: &str,
    workspace: &WorkspaceEnv,
) -> Result<Option<GitRepoInfo>> {
    let cwd = canonical_dir(registry, cwd, workspace)?;
    if !registry.is_authorized(&cwd.local_path) {
        return Err(GitError::PathOutsideWorkspace(cwd.local_path));
    }
    ensure_git_available(&cwd.workspace)?;
    resolve_repo_in_authorized(registry, &cwd)
}

fn resolve_repo_in_authorized(
    registry: &WorkspaceRegistry,
    cwd: &ResolvedGitDirectory,
) -> Result<Option<GitRepoInfo>> {
    super::ownership::authorize_containing_metadata(registry, &cwd.local_path)?;
    let Some(location) = worktree::locate_work_tree(&cwd.workspace, &cwd.git_path)? else {
        return Ok(None);
    };
    let canonical_root = discovered_root(registry, cwd, &location.toplevel)?;

    let head = match git_stdout_lines(
        &canonical_root.workspace,
        &canonical_root.git_path,
        ["rev-parse", "--abbrev-ref", "HEAD"],
    )?
    .into_iter()
    .next()
    {
        Some(h) => h,
        None => git_stdout_line_opt(
            &canonical_root.workspace,
            &canonical_root.git_path,
            ["symbolic-ref", "--short", "HEAD"],
        )?
        .ok_or(GitError::CommandFailed {
            context: "failed to resolve HEAD",
            detail: String::new(),
        })?,
    };

    let upstream = git_stdout_line_opt(
        &canonical_root.workspace,
        &canonical_root.git_path,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?;

    Ok(Some(GitRepoInfo {
        repo_root: canonical_root.git_path,
        branch: head.clone(),
        upstream,
        is_detached: head == "HEAD",
        linked_worktree: location.linked_worktree,
    }))
}

fn discovered_root(
    registry: &WorkspaceRegistry,
    cwd: &ResolvedGitDirectory,
    root: &str,
) -> Result<ResolvedGitDirectory> {
    let root = canonical_dir(registry, root, &cwd.workspace)?;
    // Preserve ordinary discovery from a subdirectory, but never let Git
    // configuration grant access to a different worktree or skip a nearer one.
    if !cwd.local_path.starts_with(&root.local_path) {
        return Err(GitError::PathOutsideWorkspace(root.local_path));
    }
    for ancestor in cwd.local_path.ancestors() {
        match std::fs::symlink_metadata(ancestor.join(".git")) {
            Ok(_) if ancestor == root.local_path => {
                super::ownership::authorize_repository_metadata(registry, &root.local_path)?;
                registry.authorize(&root.local_path)?;
                return authorized_repo_root(registry, &root.git_path, &root.workspace);
            }
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        if ancestor == root.local_path {
            break;
        }
    }
    Err(GitError::command(
        "repository discovery",
        "Git's reported worktree does not own this directory",
    ))
}

const MAX_DISCOVERED_REPOS: usize = 24;
const MAX_DISCOVERY_READS: usize = 256;
/// How deep below the folder repositories are looked for (children and grandchildren).
const DISCOVERY_DEPTH: usize = 2;
/// Folders never searched for repositories: hidden ones and dependency or build trees.
const DISCOVERY_SKIP: &[&str] = &["node_modules", "target", "vendor", "dist", "build"];

/// Git work trees inside `path`, a folder that holds several projects without being one
/// itself, spelled under `path` as given. Children and grandchildren are searched, a
/// repository is not searched further, links are not followed, and the walk stops after a
/// fixed number of folder reads, so a huge folder costs a bounded amount.
pub fn discover_repos(
    registry: &WorkspaceRegistry,
    path: &str,
    workspace: &WorkspaceEnv,
) -> Result<Vec<String>> {
    let dir = canonical_dir(registry, path, workspace)?;
    if !registry.is_authorized(&dir.local_path) {
        return Err(GitError::PathOutsideWorkspace(dir.local_path));
    }
    let base = match path.trim_end_matches('/') {
        "" => "/".to_string(),
        trimmed => trimmed.to_string(),
    };
    let mut found: Vec<String> = Vec::new();
    let mut queue: VecDeque<(PathBuf, String, usize)> = VecDeque::from([(dir.local_path, base, 0)]);
    let mut reads = 0;
    while let Some((local, spelled, depth)) = queue.pop_front() {
        if reads == MAX_DISCOVERY_READS {
            break;
        }
        reads += 1;
        let Ok(entries) = std::fs::read_dir(&local) else {
            continue;
        };
        let mut children: Vec<(String, PathBuf)> = entries
            .filter_map(|entry| {
                let entry = entry.ok()?;
                // `file_type` does not follow links, so a link never leads the walk astray.
                if !entry.file_type().ok()?.is_dir() {
                    return None;
                }
                let name = entry.file_name().into_string().ok()?;
                if name.starts_with('.') || DISCOVERY_SKIP.contains(&name.as_str()) {
                    return None;
                }
                Some((name, entry.path()))
            })
            .collect();
        children.sort_unstable();
        for (name, child) in children {
            let child_spelled = if spelled.ends_with('/') {
                format!("{spelled}{name}")
            } else {
                format!("{spelled}/{name}")
            };
            if child.join(".git").exists() {
                found.push(child_spelled);
                if found.len() == MAX_DISCOVERED_REPOS {
                    return Ok(found);
                }
            } else if depth + 1 < DISCOVERY_DEPTH {
                queue.push_back((child, child_spelled, depth + 1));
            }
        }
    }
    Ok(found)
}

pub fn panel_snapshot(
    registry: &WorkspaceRegistry,
    cwd: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitPanelSnapshot> {
    let cwd = canonical_dir(registry, cwd, workspace)?;
    if !registry.is_authorized(&cwd.local_path) {
        return Err(GitError::PathOutsideWorkspace(cwd.local_path));
    }
    ensure_git_available(&cwd.workspace)?;
    super::ownership::authorize_containing_metadata(registry, &cwd.local_path)?;
    let Some(location) = worktree::locate_work_tree(&cwd.workspace, &cwd.git_path)? else {
        return Ok(GitPanelSnapshot {
            repo: None,
            status: None,
        });
    };
    let canonical_root = discovered_root(registry, &cwd, &location.toplevel)?;

    let status = status_inner(&canonical_root)?;
    let repo = GitRepoInfo {
        repo_root: canonical_root.git_path.clone(),
        branch: status.branch.clone(),
        upstream: status.upstream.clone(),
        is_detached: status.is_detached,
        linked_worktree: location.linked_worktree,
    };
    Ok(GitPanelSnapshot {
        repo: Some(repo),
        status: Some(status),
    })
}

pub fn status(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitStatusSnapshot> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    status_inner(&repo_root)
}

fn status_inner(repo_root: &ResolvedGitDirectory) -> Result<GitStatusSnapshot> {
    let output = repo_root.run(
        [
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=normal",
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git status failed")?;

    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    let parsed = parse_porcelain_v2(stdout);
    let files = untracked::expand_untracked_dirs(parsed.files, |dir, budget| {
        list_untracked_in(repo_root, dir, budget)
    });

    Ok(GitStatusSnapshot {
        repo_root: repo_root.git_path.clone(),
        branch: parsed.branch,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
        is_detached: parsed.is_detached,
        truncated: output.truncated,
        changed_files: files,
    })
}

/// Files git reports as untracked (and not ignored) under `dir`, or `None` when
/// there are more than `budget` or the listing fails. The walk is abandoned as
/// soon as the output exceeds what `budget` entries could need.
fn list_untracked_in(
    repo_root: &ResolvedGitDirectory,
    dir: &str,
    budget: usize,
) -> Option<Vec<String>> {
    let output = run_git_capped(
        &repo_root.workspace,
        Some(&repo_root.git_path),
        [
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--full-name",
            "--",
            dir,
        ],
        DEFAULT_TIMEOUT_SECS,
        untracked::LISTING_CAP_BYTES,
    )
    .ok()?;
    if output.truncated || output.timed_out {
        return None;
    }
    // A listing that was cut short by the cap above reports exit failure.
    if output.exit_code != Some(0) {
        return None;
    }
    untracked::parse_listing(&output.stdout, budget)
}

pub fn diff(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    path: Option<&str>,
    staged: bool,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    diff_inner(&repo_root, path, staged)
}

fn diff_inner(
    repo_root: &ResolvedGitDirectory,
    path: Option<&str>,
    staged: bool,
) -> Result<GitDiffResult> {
    let mut args: Vec<OsString> = vec![
        "diff".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
    ];
    if staged {
        args.push("--cached".into());
    }
    let pathspec = match path.filter(|p| !p.is_empty()) {
        Some(p) => Some(if staged {
            git_entry_name(p)?
        } else {
            pathspec_from_input(&repo_root.local_path, p)?
        }),
        None => None,
    };
    if let Some(spec) = pathspec.as_ref() {
        args.push("--".into());
        args.push(spec.clone().into());
    }
    let output = repo_root.run(args, DEFAULT_TIMEOUT_SECS)?;
    ensure_success(&output, "git diff failed")?;

    let diff_text = match String::from_utf8(output.stdout) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };
    Ok(GitDiffResult {
        diff_text,
        truncated: output.truncated,
    })
}

pub fn diff_content(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    path: &str,
    staged: bool,
    _original_path: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffContentResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let rel_path = git_entry_name(path)?;
    let worktree_path = if staged {
        repo_root.local_path.join(&rel_path)
    } else {
        git_worktree_entry(&repo_root.local_path, &rel_path)?
    };

    // An open working diff can outlive a rename change in the index. Its tab's
    // original-path hint is a snapshot, so obtain the current source from Git.
    let original_rel = if staged {
        let output = repo_root.run(
            ["status", "--porcelain=v2", "-z", "--untracked-files=no"],
            DEFAULT_TIMEOUT_SECS,
        )?;
        ensure_success(&output, "git status failed")?;
        if output.truncated {
            return Err(GitError::command(
                "git diff",
                "staged path list is truncated",
            ));
        }
        let text = std::str::from_utf8(&output.stdout)
            .map_err(|_| GitError::command("git diff", "cannot decode staged paths"))?;
        parse_porcelain_v2(text)
            .files
            .into_iter()
            .find(|file| file.path == rel_path)
            .and_then(|file| file.original_path)
    } else {
        None
    };

    let original = if staged {
        let spec = original_rel.as_deref().unwrap_or(&rel_path);
        git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!("HEAD:{spec}"),
        )?
    } else {
        git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!(":{rel_path}"),
        )?
    };
    let modified = if staged {
        git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!(":{rel_path}"),
        )?
    } else {
        read_text_file(&repo_root.local_path, &worktree_path)?
    };
    let patch = diff_inner(&repo_root, Some(&rel_path), staged)?;
    let is_binary =
        matches!(original, TextSource::Binary) || matches!(modified, TextSource::Binary);

    Ok(GitDiffContentResult {
        original_content: original.into_text(),
        modified_content: modified.into_text(),
        is_binary,
        fallback_patch: patch.diff_text,
        truncated: patch.truncated,
    })
}

/// The HEAD version of a file, for the editor's change gutter: one `git show`
/// run in the file's own folder, so no repository lookup is needed. None when
/// the file is not in HEAD (untracked, new, outside a repository), is binary,
/// or is too large to show whole.
pub fn file_base(
    registry: &WorkspaceRegistry,
    path: &str,
    workspace: &WorkspaceEnv,
) -> Result<Option<String>> {
    let Some(i) = path.rfind(['/', '\\']) else {
        return Ok(None);
    };
    let name = &path[i + 1..];
    if matches!(name, "" | "." | "..") {
        return Ok(None);
    }
    // A file at a root keeps its separator ("/", "C:\").
    let dir = if i == 0 || path[..i].ends_with(':') {
        &path[..=i]
    } else {
        &path[..i]
    };
    let cwd = canonical_dir(registry, dir, workspace)?;
    if !registry.is_authorized(&cwd.local_path) {
        return Err(GitError::PathOutsideWorkspace(cwd.local_path));
    }
    ensure_git_available(&cwd.workspace)?;
    let spec = format!("HEAD:./{name}");
    super::ownership::authorize_containing_metadata(registry, &cwd.local_path)?;
    let Some(location) = worktree::locate_work_tree(&cwd.workspace, &cwd.git_path)? else {
        return Ok(None);
    };
    let _guarded = discovered_root(registry, &cwd, &location.toplevel)?;
    let output = run_git_guarded(
        &cwd.workspace,
        Some(&cwd.git_path),
        [
            OsStr::new("show"),
            OsStr::new("--no-show-signature"),
            OsStr::new("--no-textconv"),
            OsStr::new(&spec),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.timed_out {
        return Err(GitError::TimedOut("git show"));
    }
    if output.exit_code != Some(0) || output.truncated {
        return Ok(None);
    }
    Ok(match decode_text(output.stdout) {
        TextSource::Text(text) => Some(text),
        TextSource::Missing | TextSource::Binary => None,
    })
}

/// Most bytes of paths one git command line carries. Windows caps a whole command line at
/// 32,767 UTF-16 units (UTF-8 bytes never count fewer) and `wsl.exe` adds arguments of its
/// own, so Stage All on a deleted folder of a few hundred files could not start git at all.
/// Unix allows far more, but not without bound.
#[cfg(windows)]
const PATHSPEC_BATCH_BYTES: usize = 16 * 1024;
#[cfg(not(windows))]
const PATHSPEC_BATCH_BYTES: usize = 256 * 1024;

/// Splits pathspecs, in order, into runs that each fit one command line. A path longer than
/// the budget gets a run of its own.
fn pathspec_batches(paths: &[String], budget: usize) -> Vec<&[String]> {
    let mut batches = Vec::new();
    let mut start = 0;
    let mut used = 0;
    for (i, path) in paths.iter().enumerate() {
        // Quoting and a separator per argument.
        let cost = path.len() + 3;
        if i > start && used + cost > budget {
            batches.push(&paths[start..i]);
            start = i;
            used = 0;
        }
        used += cost;
    }
    if start < paths.len() {
        batches.push(&paths[start..]);
    }
    batches
}

/// `git <command...> -- <paths>`, as many times as the command line limit needs.
fn run_git_on_paths(
    repo_root: &ResolvedGitDirectory,
    command: &[&str],
    paths: &[String],
    context: &'static str,
) -> Result<()> {
    for batch in pathspec_batches(paths, PATHSPEC_BATCH_BYTES) {
        let output = repo_root.run(pathspec_args(command, batch), DEFAULT_TIMEOUT_SECS)?;
        ensure_success(&output, context)?;
    }
    Ok(())
}

fn pathspec_args(command: &[&str], paths: &[String]) -> Vec<OsString> {
    let mut args: Vec<OsString> = command.iter().map(OsString::from).collect();
    args.push("--".into());
    args.extend(paths.iter().map(OsString::from));
    args
}

pub fn stage(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    paths: &[String],
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = owned_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if paths.is_empty() {
        return Ok(());
    }
    let resolved = resolve_pathspecs(&repo_root.local_path, paths)?;
    run_git_on_paths(&repo_root, &["add"], &resolved, "git add failed")
}

pub fn unstage(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    paths: &[String],
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = owned_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if paths.is_empty() {
        return Ok(());
    }
    let resolved = paths
        .iter()
        .map(|path| git_entry_name(path))
        .collect::<Result<Vec<_>>>()?;
    for batch in pathspec_batches(&resolved, PATHSPEC_BATCH_BYTES) {
        let output = repo_root.run(
            pathspec_args(&["reset", "HEAD"], batch),
            DEFAULT_TIMEOUT_SECS,
        )?;
        if output.exit_code == Some(0) {
            continue;
        }
        if !looks_like_no_head(&output) {
            return ensure_success(&output, "git reset failed");
        }
        let output = repo_root.run(
            pathspec_args(&["rm", "--cached", "-r"], batch),
            DEFAULT_TIMEOUT_SECS,
        )?;
        ensure_success(&output, "git rm --cached failed")?;
    }
    Ok(())
}

fn looks_like_no_head(output: &GitOutput) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    stderr.contains("ambiguous argument 'head'")
        || stderr.contains("unknown revision")
        || stderr.contains("does not have any commits yet")
        || stderr.contains("bad revision 'head'")
}

pub fn discard(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    entries: &[DiscardEntry],
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = owned_repo_root(registry, repo_root, workspace)?;
    discard_owned(registry, &repo_root, entries)
}
pub(crate) fn discard_owned(
    registry: &WorkspaceRegistry,
    repo_root: &ResolvedGitDirectory,
    entries: &[DiscardEntry],
) -> Result<()> {
    let owner = repo_root
        .ownership
        .as_ref()
        .ok_or_else(|| GitError::command("discard", "Repository ownership is missing"))?;
    owner.validate()?;
    if !registry.is_authorized(owner.path()) {
        return Err(GitError::PathOutsideWorkspace(owner.path().into()));
    }
    ensure_git_available(&repo_root.workspace)?;
    if entries.is_empty() {
        return Ok(());
    }

    let mut tracked: Vec<String> = Vec::with_capacity(entries.len());
    let mut untracked: Vec<String> = Vec::new();
    for entry in entries {
        let resolved = pathspec_from_input(&repo_root.local_path, &entry.path)?;
        if entry.untracked {
            untracked.push(resolved);
        } else {
            tracked.push(resolved);
        }
    }

    run_git_on_paths(
        repo_root,
        &["restore", "--worktree"],
        &tracked,
        "git restore failed",
    )?;
    run_git_on_paths(
        repo_root,
        &["clean", "-f", "-d"],
        &untracked,
        "git clean failed",
    )
}

pub fn commit(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    message: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitCommitResult> {
    let repo_root = owned_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(GitError::EmptyCommitMessage);
    }

    let output = super::process::run_guarded_commit(&repo_root, trimmed, COMMIT_TIMEOUT_SECS)?;
    ensure_commit_success(&output)?;

    let combined = repo_root.lines([
        "show",
        "--no-show-signature",
        "-s",
        "--format=%H%n%s",
        "HEAD",
    ])?;
    let sha = combined.first().cloned().ok_or(GitError::CommandFailed {
        context: "failed to resolve commit sha",
        detail: String::new(),
    })?;
    let summary = combined.get(1).cloned().unwrap_or_default();

    Ok(GitCommitResult {
        commit_sha: sha,
        summary,
    })
}

pub fn push(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitPushResult> {
    let repo_root = owned_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    super::remote_guard::inspect(
        registry,
        &repo_root,
        super::remote_guard::RemoteAction::Push,
    )?;

    let upstream = repo_root.line(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?;
    if upstream.is_none() {
        return Err(GitError::NoUpstream);
    }

    let output = repo_root.run(["push"], NETWORK_TIMEOUT_SECS)?;
    ensure_success(&output, "git push failed")?;

    let upstream = upstream.unwrap();
    let (remote, branch) = split_upstream(&upstream);
    Ok(GitPushResult {
        remote,
        branch,
        pushed: true,
    })
}

const LOG_FORMAT: &str = "%H%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%s";
const MAX_LOG_LIMIT: u32 = 200;

pub fn log(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    limit: u32,
    skip: u32,
    anchor_sha: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitLogEntry>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    let bounded = limit.clamp(1, MAX_LOG_LIMIT);
    let count_arg = format!("--max-count={bounded}");
    let skip_arg = format!("--skip={skip}");
    let format_arg = format!("--format={LOG_FORMAT}");
    // Pages are slices of `git log` from a fixed commit. The history reachable
    // from it never changes, so paging stays exact even if HEAD moves, and
    // commits that only a merge's second parent reaches are not skipped.
    let anchor = match anchor_sha {
        Some(sha) if !sha.is_empty() => {
            if !sha_is_safe(sha) {
                return Err(GitError::command("git log", "invalid anchor sha"));
            }
            Some(sha)
        }
        _ => None,
    };
    let mut args: Vec<&OsStr> = vec![
        OsStr::new("log"),
        OsStr::new("--no-show-signature"),
        OsStr::new("--no-color"),
        // Full ref names in `%D`, so refs are classified by namespace.
        OsStr::new("--decorate=full"),
        OsStr::new("--shortstat"),
        OsStr::new(&count_arg),
        OsStr::new(&skip_arg),
        OsStr::new(&format_arg),
    ];
    if let Some(sha) = anchor {
        args.push(OsStr::new(sha));
    }
    let output = repo_root.run(args, DEFAULT_TIMEOUT_SECS)?;
    if output.timed_out {
        return Err(GitError::TimedOut("git log"));
    }
    if output.exit_code != Some(0) {
        let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if stderr.contains("does not have any commits yet")
            || stderr.contains("bad default revision")
            || stderr.contains("unknown revision")
            || stderr.contains("ambiguous argument 'head'")
        {
            return Ok(Vec::new());
        }
        return ensure_success(&output, "git log failed").map(|_| Vec::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries: Vec<GitLogEntry> = Vec::with_capacity(bounded as usize);
    // Lines we get back interleave:
    //   <sha>\x1f<author>\x1f<email>\x1f<ts>\x1f<parents>\x1f<refs>\x1f<subject>
    //   <blank>
    //    5 files changed, 12 insertions(+), 3 deletions(-)
    // Commits without diffstats (root commits, merges with no changes) just
    // skip the shortstat line. Detect commit headers by the presence of
    // the unit-separator we put in the format.
    for raw_line in stdout.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if line.contains('\x1f') {
            let mut fields = line.splitn(7, '\x1f');
            let sha = fields.next().unwrap_or("").to_string();
            if !sha_is_safe(&sha) {
                continue;
            }
            let author = fields.next().unwrap_or("").to_string();
            let author_email = fields.next().unwrap_or("").to_string();
            let timestamp = fields.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
            let parents_raw = fields.next().unwrap_or("");
            let parents: Vec<String> = parents_raw
                .split_ascii_whitespace()
                .map(|s| s.to_string())
                .collect();
            let refs = parse_decorations(fields.next().unwrap_or(""));
            let subject = fields.next().unwrap_or("").to_string();
            let short_sha = sha.chars().take(7).collect::<String>();
            entries.push(GitLogEntry {
                sha,
                short_sha,
                author,
                author_email,
                timestamp_secs: timestamp,
                parents,
                refs,
                subject,
                files_changed: 0,
                insertions: 0,
                deletions: 0,
            });
            continue;
        }
        if let Some(current) = entries.last_mut() {
            if line.contains("file changed") || line.contains("files changed") {
                let (files, ins, del) = parse_shortstat(line);
                current.files_changed = files;
                current.insertions = ins;
                current.deletions = del;
            }
        }
    }
    Ok(entries)
}

pub fn show_commit_diff(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git show", "invalid commit identifier"));
    }
    let output = repo_root.run(
        [
            OsStr::new("show"),
            OsStr::new("--no-show-signature"),
            OsStr::new("--no-color"),
            OsStr::new("--no-ext-diff"),
            OsStr::new("--no-textconv"),
            OsStr::new("--patch-with-stat"),
            OsStr::new(sha),
            OsStr::new("--"),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git show failed")?;
    let diff_text = match String::from_utf8(output.stdout) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };
    Ok(GitDiffResult {
        diff_text,
        truncated: output.truncated,
    })
}

fn parse_shortstat(tail: &str) -> (u32, u32, u32) {
    // Looks for a line like " 5 files changed, 12 insertions(+), 3 deletions(-)"
    for line in tail.lines() {
        let trimmed = line.trim();
        if !(trimmed.contains("file changed") || trimmed.contains("files changed")) {
            continue;
        }
        let mut files = 0u32;
        let mut ins = 0u32;
        let mut del = 0u32;
        for part in trimmed.split(',') {
            let part = part.trim();
            let num_str = part.split_ascii_whitespace().next().unwrap_or("0");
            let n: u32 = num_str.parse().unwrap_or(0);
            if part.contains("file") {
                files = n;
            } else if part.contains("insertion") {
                ins = n;
            } else if part.contains("deletion") {
                del = n;
            }
        }
        return (files, ins, del);
    }
    (0, 0, 0)
}

pub(super) fn sha_is_safe(sha: &str) -> bool {
    !sha.is_empty() && sha.len() <= 64 && sha.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn commit_files(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    workspace: &WorkspaceEnv,
) -> Result<Vec<GitCommitFileChange>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git diff-tree", "invalid commit sha"));
    }

    let output = repo_root.run(
        [
            OsStr::new("diff-tree"),
            OsStr::new("--no-commit-id"),
            OsStr::new("-r"),
            OsStr::new("-z"),
            OsStr::new("--raw"),
            OsStr::new("--no-abbrev"),
            OsStr::new("--root"),
            OsStr::new("--first-parent"),
            OsStr::new("-m"),
            OsStr::new("-M"),
            OsStr::new("--no-ext-diff"),
            OsStr::new("--no-textconv"),
            OsStr::new("--numstat"),
            OsStr::new(sha),
            OsStr::new("--"),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    ensure_success(&output, "git diff-tree failed")?;

    if output.truncated {
        return Err(GitError::command(
            "git diff-tree",
            "Commit file list exceeds the output limit; view this commit in the terminal",
        ));
    }
    super::commit_files::parse(&output.stdout)
        .map_err(|detail| GitError::command("git diff-tree", detail))
}

pub fn commit_file_diff(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    sha: &str,
    path: &str,
    original_path: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<GitDiffContentResult> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if !sha_is_safe(sha) {
        return Err(GitError::command("git show", "invalid commit sha"));
    }
    let rel = git_entry_name(path)?;
    let original_rel = match original_path {
        Some(orig) if !orig.is_empty() => git_entry_name(orig)?,
        _ => rel.clone(),
    };

    let parent = repo_root.line(["rev-parse", &format!("{sha}^")])?;
    let original = match parent.as_deref() {
        Some(p) => git_show_text(
            &repo_root.workspace,
            &repo_root.git_path,
            &format!("{p}:{original_rel}"),
        )?,
        None => TextSource::Missing,
    };
    let modified = git_show_text(
        &repo_root.workspace,
        &repo_root.git_path,
        &format!("{sha}:{rel}"),
    )?;

    let mut diff_args: Vec<OsString> = vec![
        "show".into(),
        "--no-show-signature".into(),
        "--no-color".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        "--format=".into(),
        "-m".into(),
        "--first-parent".into(),
        sha.into(),
        "--".into(),
    ];
    diff_args.push(rel.clone().into());
    if original_rel != rel {
        diff_args.push(original_rel.clone().into());
    }
    let patch_output = repo_root.run(diff_args, DEFAULT_TIMEOUT_SECS)?;
    ensure_success(&patch_output, "git show <commit> -- <path> failed")?;
    let patch_text = match String::from_utf8(patch_output.stdout) {
        Ok(text) => text,
        Err(e) => String::from_utf8_lossy(&e.into_bytes()).into_owned(),
    };

    let is_binary =
        matches!(original, TextSource::Binary) || matches!(modified, TextSource::Binary);

    Ok(GitDiffContentResult {
        original_content: original.into_text(),
        modified_content: modified.into_text(),
        is_binary,
        fallback_patch: patch_text,
        truncated: patch_output.truncated,
    })
}

pub fn remote_url(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    name: &str,
    workspace: &WorkspaceEnv,
) -> Result<Option<String>> {
    let repo_root = authorized_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    if name.is_empty() || name.len() > 64 || !name.chars().all(is_remote_name_char) {
        return Ok(None);
    }
    repo_root.line(["config", "--get", &format!("remote.{name}.url")])
}

fn is_remote_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'
}

pub fn fetch(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = owned_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    super::remote_guard::inspect(
        registry,
        &repo_root,
        super::remote_guard::RemoteAction::Fetch,
    )?;
    let output = repo_root.run(["fetch", "--prune"], NETWORK_TIMEOUT_SECS)?;
    ensure_success(&output, "git fetch failed")
}

pub fn pull_ff_only(
    registry: &WorkspaceRegistry,
    repo_root: &str,
    workspace: &WorkspaceEnv,
) -> Result<()> {
    let repo_root = owned_repo_root(registry, repo_root, workspace)?;
    ensure_git_available(&repo_root.workspace)?;
    super::remote_guard::inspect(
        registry,
        &repo_root,
        super::remote_guard::RemoteAction::Fetch,
    )?;
    let output = repo_root.run(["pull", "--ff-only"], NETWORK_TIMEOUT_SECS)?;
    ensure_success(&output, "git pull --ff-only failed")
}

fn ensure_commit_success(output: &GitOutput) -> Result<()> {
    if output.timed_out {
        return Err(GitError::CommitTimedOut);
    }
    if output.exit_code != Some(0) && nothing_to_commit(output) {
        return Err(GitError::command("git commit", "nothing staged"));
    }
    ensure_success(output, "git commit failed")
}

fn nothing_to_commit(output: &GitOutput) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    let stdout = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    stderr.contains("nothing to commit") || stdout.contains("nothing to commit")
}

fn resolve_pathspecs(repo_root: &Path, paths: &[String]) -> Result<Vec<String>> {
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        out.push(pathspec_from_input(repo_root, p)?);
    }
    Ok(out)
}

fn pathspec_from_input(repo_root: &Path, rel: &str) -> Result<String> {
    git_worktree_entry(repo_root, rel)?;
    git_entry_name(rel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::git::commit_files::status_label_for;

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
    fn file_base_reads_the_committed_version() {
        let repo = tempfile::tempdir().unwrap();
        let root = repo.path();
        if !git(root, &["init", "-q"]) {
            return;
        }
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("src/a b.ts"), "one\n").unwrap();
        assert!(git(root, &["add", "."]));
        assert!(git(root, &["commit", "-q", "-m", "init"]));
        std::fs::write(root.join("src/a b.ts"), "two\n").unwrap();
        std::fs::write(root.join("src/new.ts"), "new\n").unwrap();

        let registry = WorkspaceRegistry::default();
        registry.authorize(root).unwrap();
        let local = WorkspaceEnv::Local;
        let file = |name: &str| root.join("src").join(name).to_string_lossy().into_owned();
        assert_eq!(
            file_base(&registry, &file("a b.ts"), &local)
                .unwrap()
                .as_deref(),
            Some("one\n")
        );
        assert_eq!(file_base(&registry, &file("new.ts"), &local).unwrap(), None);
        assert_eq!(file_base(&registry, "relative.ts", &local).unwrap(), None);

        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("x.ts"), "x").unwrap();
        let path = outside.path().join("x.ts").to_string_lossy().into_owned();
        assert!(file_base(&registry, &path, &local).is_err());
    }

    #[test]
    fn pathspec_batches_fit_the_budget_and_keep_every_path_once_in_order() {
        let paths: Vec<String> = (0..10).map(|i| format!("dir/file-{i}.txt")).collect();
        // Each path costs its 14 bytes plus 3.
        let batches = pathspec_batches(&paths, 40);
        assert!(batches.iter().all(|batch| batch.len() == 2));
        assert_eq!(batches.concat(), paths);
        assert_eq!(pathspec_batches(&paths, 1 << 20), vec![&paths[..]]);
        assert!(pathspec_batches(&[], 40).is_empty());
    }

    #[test]
    fn a_path_longer_than_the_budget_still_gets_a_batch() {
        let paths = vec!["a".to_owned(), "x".repeat(100), "b".to_owned()];
        let batches = pathspec_batches(&paths, 10);
        assert_eq!(
            batches,
            vec![&paths[0..1], &paths[1..2], &paths[2..3]],
            "nothing is dropped and nothing is merged past the budget"
        );
    }

    #[test]
    fn commit_timeout_covers_slow_hooks() {
        const { assert!(COMMIT_TIMEOUT_SECS > DEFAULT_TIMEOUT_SECS) };
        assert_eq!(
            COMMIT_TIMEOUT_SECS,
            crate::modules::git::types::MAX_TIMEOUT_SECS
        );
    }

    #[test]
    fn ensure_commit_success_maps_timeout_to_hooks_error() {
        let out = GitOutput {
            stdout: Vec::new(),
            stderr: Vec::new(),
            exit_code: None,
            timed_out: true,
            truncated: false,
        };
        assert!(matches!(
            ensure_commit_success(&out),
            Err(GitError::CommitTimedOut)
        ));
    }

    #[test]
    fn ensure_commit_success_keeps_nothing_staged_mapping() {
        let out = GitOutput {
            stdout: b"nothing to commit, working tree clean".to_vec(),
            stderr: Vec::new(),
            exit_code: Some(1),
            timed_out: false,
            truncated: false,
        };
        let err = ensure_commit_success(&out).unwrap_err();
        assert_eq!(err.to_string(), "git commit: nothing staged");
    }

    #[test]
    fn sha_is_safe_accepts_hex() {
        assert!(sha_is_safe("abc123"));
        assert!(sha_is_safe(&"a".repeat(40)));
        assert!(sha_is_safe(&"f".repeat(64)));
    }

    #[test]
    fn sha_is_safe_rejects_non_hex_or_oversize() {
        assert!(!sha_is_safe(""));
        assert!(!sha_is_safe("abcg"));
        assert!(!sha_is_safe("abc 123"));
        assert!(!sha_is_safe(&"a".repeat(65)));
        assert!(!sha_is_safe(";rm -rf /"));
    }

    #[test]
    fn is_remote_name_char_allows_word_and_punct() {
        for c in "abcXYZ012-_.".chars() {
            assert!(is_remote_name_char(c));
        }
        for c in " /:\\?\"'".chars() {
            assert!(!is_remote_name_char(c));
        }
    }

    #[test]
    fn parse_shortstat_pulls_three_counts() {
        let line = " 5 files changed, 12 insertions(+), 3 deletions(-)";
        assert_eq!(parse_shortstat(line), (5, 12, 3));
    }

    #[test]
    fn parse_shortstat_handles_singular_file() {
        let line = " 1 file changed, 1 insertion(+)";
        assert_eq!(parse_shortstat(line), (1, 1, 0));
    }

    #[test]
    fn parse_shortstat_returns_zeros_when_absent() {
        assert_eq!(parse_shortstat("no stat here"), (0, 0, 0));
    }

    #[test]
    fn status_label_for_known_chars() {
        assert_eq!(status_label_for('A'), "Added");
        assert_eq!(status_label_for('M'), "Modified");
        assert_eq!(status_label_for('D'), "Deleted");
        assert_eq!(status_label_for('R'), "Renamed");
        assert_eq!(status_label_for('C'), "Copied");
    }

    #[test]
    fn status_label_for_unknown_falls_back() {
        assert_eq!(status_label_for('X'), "Status X");
    }

    #[test]
    fn looks_like_no_head_recognizes_phrases() {
        let mk = |s: &str| GitOutput {
            stdout: Vec::new(),
            stderr: s.as_bytes().to_vec(),
            exit_code: Some(128),
            timed_out: false,
            truncated: false,
        };
        assert!(looks_like_no_head(&mk(
            "fatal: ambiguous argument 'HEAD': unknown revision"
        )));
        assert!(looks_like_no_head(&mk(
            "fatal: your current branch 'main' does not have any commits yet"
        )));
        assert!(!looks_like_no_head(&mk("fatal: pathspec did not match")));
    }
}
