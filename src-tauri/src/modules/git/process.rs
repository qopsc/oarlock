use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::modules::git::errors::{GitError, Result};
use crate::modules::git::types::{
    GitOutput, TextSource, DEFAULT_TIMEOUT_SECS, MAX_FILE_BYTES, MAX_OUTPUT_BYTES,
    MAX_TIMEOUT_SECS, MIN_GIT_VERSION,
};
use crate::modules::proc::capture::{self, Limits, OnTimeout};
#[cfg(windows)]
use crate::modules::workspace::validate_wsl_distro_name;
use crate::modules::workspace::WorkspaceEnv;

#[derive(Clone)]
enum Availability {
    Ok,
    NotInstalled,
    TooOld(String),
}

const AVAILABILITY_TTL: Duration = Duration::from_secs(60);

struct AvailabilityCache {
    value: Availability,
    checked_at: Instant,
}

static GIT_AVAILABILITY: OnceLock<Mutex<HashMap<String, AvailabilityCache>>> = OnceLock::new();

fn availability_cell() -> &'static Mutex<HashMap<String, AvailabilityCache>> {
    GIT_AVAILABILITY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prune_expired_availability_entries(cache: &mut HashMap<String, AvailabilityCache>) {
    cache.retain(|_, entry| entry.checked_at.elapsed() < AVAILABILITY_TTL);
}

fn workspace_cache_key(workspace: &WorkspaceEnv) -> String {
    match workspace {
        WorkspaceEnv::Local => "local".into(),
        WorkspaceEnv::Wsl { distro } => format!("wsl:{distro}"),
    }
}

pub fn ensure_git_available(workspace: &WorkspaceEnv) -> Result<()> {
    let cache_key = workspace_cache_key(workspace);
    let cached = {
        let mut guard = availability_cell()
            .lock()
            .expect("git availability poisoned");
        prune_expired_availability_entries(&mut guard);
        guard
            .get(&cache_key)
            .filter(|entry| entry.checked_at.elapsed() < AVAILABILITY_TTL)
            .map(|entry| entry.value.clone())
    };
    let value = match cached {
        Some(v) => v,
        None => {
            let fresh = check_git_availability(workspace);
            let mut guard = availability_cell()
                .lock()
                .expect("git availability poisoned");
            prune_expired_availability_entries(&mut guard);
            guard.insert(
                cache_key,
                AvailabilityCache {
                    value: fresh.clone(),
                    checked_at: Instant::now(),
                },
            );
            fresh
        }
    };
    match value {
        Availability::Ok => Ok(()),
        Availability::NotInstalled => Err(GitError::NotInstalled),
        Availability::TooOld(v) => Err(GitError::TooOld {
            found: v,
            required: MIN_GIT_VERSION,
        }),
    }
}

fn check_git_availability(workspace: &WorkspaceEnv) -> Availability {
    let output = match run_git(workspace, None, ["--version"], 10) {
        Ok(o) => o,
        Err(_) => return Availability::NotInstalled,
    };
    if output.timed_out || output.exit_code != Some(0) {
        return Availability::NotInstalled;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = parse_git_version(stdout.trim()).unwrap_or_else(|| "unknown".into());
    if !version_meets_minimum(&version, MIN_GIT_VERSION) {
        return Availability::TooOld(version);
    }
    Availability::Ok
}

fn parse_git_version(line: &str) -> Option<String> {
    line.split_whitespace()
        .find(|tok| tok.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(|s| s.split('.').take(3).collect::<Vec<_>>().join("."))
}

fn version_meets_minimum(found: &str, required: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        s.split('.')
            .map(|p| p.parse::<u32>().unwrap_or(0))
            .collect()
    };
    let f = parse(found);
    let r = parse(required);
    for (i, &b) in r.iter().enumerate() {
        let a = f.get(i).copied().unwrap_or(0);
        if a > b {
            return true;
        }
        if a < b {
            return false;
        }
    }
    true
}

pub fn git_show_text(workspace: &WorkspaceEnv, repo_root: &str, spec: &str) -> Result<TextSource> {
    let output = run_git_guarded(
        workspace,
        Some(repo_root),
        [
            OsStr::new("show"),
            OsStr::new("--no-show-signature"),
            OsStr::new("--no-textconv"),
            OsStr::new(spec),
        ],
        DEFAULT_TIMEOUT_SECS,
    )?;
    if output.timed_out {
        return Err(GitError::TimedOut("git show"));
    }
    if output.exit_code != Some(0) {
        // A missing blob object and an absent path both make `git show` fail.
        // Ask the tree or index whether the entry exists before treating the
        // error as an ordinary addition/deletion.
        let Some((tree, path)) = spec.split_once(':') else {
            ensure_success(&output, "git show failed")?;
            unreachable!();
        };
        // build_git_command already enables --literal-pathspecs.
        let args = if tree.is_empty() {
            vec!["ls-files", "--cached", "-z", "--", path]
        } else {
            vec!["ls-tree", "--full-tree", "-z", tree, "--", path]
        };
        let entries = run_git_guarded(workspace, Some(repo_root), args, DEFAULT_TIMEOUT_SECS)?;
        if entries.timed_out {
            return Err(GitError::TimedOut("git list entry"));
        }
        if entries.exit_code == Some(0) && !entries.truncated && entries.stdout.is_empty() {
            return Ok(TextSource::Missing);
        }
        // An unborn branch has no HEAD tree. Distinguish that from a broken
        // object by checking that its symbolic branch has no ref at all.
        if tree == "HEAD" && entries.exit_code != Some(0) {
            let head = run_git_guarded(
                workspace,
                Some(repo_root),
                ["symbolic-ref", "-q", "HEAD"],
                DEFAULT_TIMEOUT_SECS,
            )?;
            if head.exit_code == Some(0) && !head.timed_out && !head.truncated {
                let name = String::from_utf8_lossy(&head.stdout).trim().to_owned();
                if name.starts_with("refs/heads/") {
                    let exists = run_git_guarded(
                        workspace,
                        Some(repo_root),
                        ["show-ref", "--verify", "--quiet", &name],
                        DEFAULT_TIMEOUT_SECS,
                    )?;
                    if exists.exit_code == Some(1) && !exists.timed_out {
                        return Ok(TextSource::Missing);
                    }
                }
            }
        }
        ensure_success(&output, "git show failed")?;
        unreachable!();
    }
    Ok(decode_text(output.stdout))
}

pub fn git_stdout_line_opt<I, S>(
    workspace: &WorkspaceEnv,
    cwd: &str,
    args: I,
) -> Result<Option<String>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = run_git_guarded(workspace, Some(cwd), args, DEFAULT_TIMEOUT_SECS)?;
    if output.timed_out {
        return Err(GitError::TimedOut("git command"));
    }
    if output.exit_code != Some(0) {
        return Ok(None);
    }
    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    let line = stdout.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        Ok(None)
    } else {
        Ok(Some(line.to_string()))
    }
}

/// Run git, returning multiple stdout lines (UTF-8). Empty trailing lines stripped.
pub fn git_stdout_lines<I, S>(workspace: &WorkspaceEnv, cwd: &str, args: I) -> Result<Vec<String>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = run_git_guarded(workspace, Some(cwd), args, DEFAULT_TIMEOUT_SECS)?;
    if output.timed_out {
        return Err(GitError::TimedOut("git command"));
    }
    if output.exit_code != Some(0) {
        return Ok(Vec::new());
    }
    let stdout = std::str::from_utf8(&output.stdout).unwrap_or("");
    Ok(stdout
        .lines()
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect())
}

pub fn read_text_file(repo_root: &Path, path: &Path) -> Result<TextSource> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(TextSource::Missing),
        Err(e) => return Err(GitError::Io(e)),
    };
    if meta.file_type().is_symlink() {
        // Git stores the link's target text; never read the target's contents.
        return Ok(decode_text(
            std::fs::read_link(path)?
                .into_os_string()
                .into_encoded_bytes(),
        ));
    }
    if !meta.is_file() {
        return Ok(TextSource::Missing);
    }
    let size = meta.len();
    if size > MAX_FILE_BYTES {
        return Err(GitError::FileTooLarge {
            path: path.to_path_buf(),
            size,
            max: MAX_FILE_BYTES,
        });
    }
    // Only the opened-file check uses the filesystem's actual spelling. Git's
    // entry name stays unchanged (e.g. its index can say lower.txt while the
    // case-insensitive working tree stores LOWER.txt).
    let expected = std::fs::canonicalize(path)?;
    if !expected.starts_with(repo_root) {
        return Err(GitError::PathOutsideWorkspace(expected));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path)?;
    let opened = crate::modules::fs::attachment::handle_path(&file)
        .map_err(|e| GitError::command("git diff", e))?;
    if !file.metadata()?.is_file() || opened != expected {
        return Err(GitError::SymlinkRejected(path.to_path_buf()));
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(GitError::FileTooLarge {
            path: path.to_path_buf(),
            size: bytes.len() as u64,
            max: MAX_FILE_BYTES,
        });
    }
    Ok(decode_text(bytes))
}

pub fn run_git<I, S>(
    workspace: &WorkspaceEnv,
    cwd: Option<&str>,
    args: I,
    timeout_secs: u64,
) -> Result<GitOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git_uncached(
        workspace,
        cwd,
        args,
        timeout_secs,
        MAX_OUTPUT_BYTES,
        false,
        false,
    )
}

pub(crate) fn run_git_guarded<I, S>(
    workspace: &WorkspaceEnv,
    cwd: Option<&str>,
    args: I,
    timeout_secs: u64,
) -> Result<GitOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git_uncached(
        workspace,
        cwd,
        args,
        timeout_secs,
        MAX_OUTPUT_BYTES,
        false,
        true,
    )
}

/// Like `run_git`, but kills git once it has produced `stdout_cap` bytes. For
/// listings whose tail is not wanted, so a huge result costs a bounded walk.
pub fn run_git_capped<I, S>(
    workspace: &WorkspaceEnv,
    cwd: Option<&str>,
    args: I,
    timeout_secs: u64,
    stdout_cap: usize,
) -> Result<GitOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git_uncached(workspace, cwd, args, timeout_secs, stdout_cap, true, true)
}

fn run_git_uncached<I, S>(
    workspace: &WorkspaceEnv,
    cwd: Option<&str>,
    args: I,
    timeout_secs: u64,
    stdout_cap: usize,
    stop_on_stdout_cap: bool,
    apply_defenses: bool,
) -> Result<GitOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<OsString> = args
        .into_iter()
        .map(|arg| arg.as_ref().to_os_string())
        .collect();
    let (args, guarded) = if apply_defenses {
        defense_args(args, workspace)
    } else {
        (args, false)
    };
    let mut cmd = build_git_command(workspace, cwd, &args)?;
    if guarded {
        cmd.env("GIT_NO_LAZY_FETCH", "1");
    }
    capture_git(cmd, timeout_secs, stdout_cap, stop_on_stdout_cap)
}
/// Discovery is read-only and already rooted in the acquired worktree directory.
pub(crate) fn discover_owned_git(
    directory: &super::ownership::DirectoryPin,
    workspace: &WorkspaceEnv,
) -> Result<GitOutput> {
    let args = [
        "rev-parse",
        "--path-format=absolute",
        "--absolute-git-dir",
        "--git-common-dir",
        "--is-bare-repository",
        "--show-toplevel",
    ]
    .map(OsString::from);
    let (args, _) = defense_args(args.to_vec(), workspace);
    let mut cmd = build_git_command(workspace, None, &args)?;
    cmd.env("GIT_NO_LAZY_FETCH", "1");
    directory.configure(&mut cmd)?;
    let output = capture_git(cmd, DEFAULT_TIMEOUT_SECS, 64 * 1024, true)?;
    directory.validate()?;
    Ok(output)
}
pub(crate) fn run_git_in<I, S>(
    repo: &super::utils::ResolvedGitDirectory,
    args: I,
    timeout_secs: u64,
) -> Result<GitOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let Some(owner) = &repo.ownership else {
        return run_git_guarded(&repo.workspace, Some(&repo.git_path), args, timeout_secs);
    };
    let args: Vec<OsString> = args
        .into_iter()
        .map(|arg| arg.as_ref().to_os_string())
        .collect();
    let (args, guarded) = defense_args(args, &repo.workspace);
    let mut cmd = build_git_command(&repo.workspace, None, &args)?;
    if guarded {
        cmd.env("GIT_NO_LAZY_FETCH", "1");
    }
    owner.configure(&mut cmd)?;
    let result = capture_git(cmd, timeout_secs, MAX_OUTPUT_BYTES, false);
    owner.validate()?;
    result
}

// Inspecting configuration must observe the actual values; version queries
// do not enter a repository. Network operations retain trusted user auth.
fn defense_args(args: Vec<OsString>, workspace: &WorkspaceEnv) -> (Vec<OsString>, bool) {
    let mut command = "";
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let Some(arg) = arg.to_str() else { break };
        if matches!(
            arg,
            "-c" | "--config-env" | "--git-dir" | "--work-tree" | "--namespace"
        ) {
            iter.next();
        } else if arg == "--version" || !arg.starts_with('-') {
            command = arg;
            break;
        }
    }
    if matches!(command, "config" | "--version") {
        return (args, false);
    }
    let network = matches!(command, "clone" | "fetch" | "push" | "pull");
    let hooks = if cfg!(windows) && !workspace.is_wsl() {
        "NUL"
    } else {
        "/dev/null"
    };
    let mut result = Vec::new();
    let mut add = |key: &str, value: &str| {
        result.push(OsString::from("-c"));
        result.push(OsString::from(format!("{key}={value}")));
    };
    for (key, value) in [
        ("core.hooksPath", hooks),
        ("core.fsmonitor", "false"),
        ("protocol.ext.allow", "never"),
        ("commit.gpgSign", "false"),
        ("diff.external", ""),
        ("core.alternateRefsCommand", ""),
        ("core.editor", ":"),
        ("sequence.editor", ":"),
        ("interactive.diffFilter", ""),
    ] {
        add(key, value);
    }
    if !network {
        for key in ["credential.helper", "core.sshCommand", "core.askPass"] {
            add(key, "");
        }
    }
    for event in [
        "pre-commit",
        "prepare-commit-msg",
        "commit-msg",
        "post-commit",
        "post-rewrite",
        "reference-transaction",
        "post-index-change",
        "pre-auto-gc",
        "pre-push",
        "post-checkout",
        "post-merge",
        "pre-merge-commit",
        "pre-rebase",
        "applypatch-msg",
        "pre-applypatch",
        "post-applypatch",
        "push-to-checkout",
        "post-update",
        "pre-receive",
        "update",
        "proc-receive",
        "post-receive",
        "sendemail-validate",
        "fsmonitor-watchman",
    ] {
        add(&format!("hook.{event}.enabled"), "false");
    }
    result.extend(args);
    (result, true)
}

/// The preflight must run before this defense-in-depth invocation. It rejects
/// configured executables; these overrides reduce the effect of later changes.
pub(crate) fn run_guarded_commit(
    repo: &super::utils::ResolvedGitDirectory,
    message: &str,
    timeout_secs: u64,
) -> Result<GitOutput> {
    let owner = repo
        .ownership
        .as_ref()
        .ok_or_else(|| GitError::command("git commit", "Repository ownership is missing"))?;
    let hooks = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut args = Vec::<OsString>::new();
    for (key, value) in [
        ("core.hooksPath", hooks),
        ("core.fsmonitor", "false"),
        ("commit.gpgSign", "false"),
        ("credential.helper", ""),
        ("core.sshCommand", ""),
        ("core.askPass", ""),
        ("core.alternateRefsCommand", ""),
        ("core.editor", ":"),
        ("sequence.editor", ":"),
        ("diff.external", ""),
        ("interactive.diffFilter", ""),
        ("hook.pre-commit.enabled", "false"),
        ("hook.prepare-commit-msg.enabled", "false"),
        ("hook.commit-msg.enabled", "false"),
        ("hook.post-commit.enabled", "false"),
        ("hook.post-rewrite.enabled", "false"),
        ("hook.reference-transaction.enabled", "false"),
        ("hook.post-index-change.enabled", "false"),
        ("hook.pre-auto-gc.enabled", "false"),
    ] {
        args.push("-c".into());
        args.push(format!("{key}={value}").into());
    }
    args.extend(["commit".into(), "-m".into(), message.into()]);
    let mut cmd = build_git_command(&repo.workspace, None, &args)?;
    cmd.env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0");
    owner.configure(&mut cmd)?;
    let result = capture_git(cmd, timeout_secs, MAX_OUTPUT_BYTES, false);
    owner.validate()?;
    result
}
fn capture_git(
    mut cmd: Command,
    timeout_secs: u64,
    stdout_cap: usize,
    stop_on_stdout_cap: bool,
) -> Result<GitOutput> {
    let dur = Duration::from_secs(timeout_secs.clamp(1, MAX_TIMEOUT_SECS));
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GCM_PROVIDER", "")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    // A killed git leaves its lock files (index.lock) behind and its hooks
    // running, so a timeout terminates the whole group and lets git clean up.
    let captured = capture::run_with(
        &mut cmd,
        dur,
        Limits {
            stdout: stdout_cap,
            stderr: MAX_OUTPUT_BYTES,
            stop_on_stdout_cap,
        },
        OnTimeout::TerminateGroup,
    )
    .map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied => {
            GitError::Spawn(e.to_string())
        }
        _ => GitError::Io(e),
    })?;

    Ok(GitOutput {
        stdout: captured.stdout,
        stderr: captured.stderr,
        exit_code: captured.exit_code,
        timed_out: captured.timed_out,
        truncated: captured.stdout_truncated,
    })
}

const ISOLATED_GIT_ENV: &[&str] = &[
    "GIT_GLOB_PATHSPECS",
    "GIT_NOGLOB_PATHSPECS",
    "GIT_ICASE_PATHSPECS",
    "GIT_LITERAL_PATHSPECS",
    // Git's repository-local environment, plus discovery/config/namespace overrides.
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_SHALLOW_FILE",
    "GIT_GRAFT_FILE",
    "GIT_REPLACE_REF_BASE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
];

fn build_git_command(
    _workspace: &WorkspaceEnv,
    cwd: Option<&str>,
    args: &[OsString],
) -> Result<Command> {
    #[cfg(windows)]
    if let WorkspaceEnv::Wsl { distro } = _workspace {
        validate_wsl_distro_name(distro)
            .map_err(|_| GitError::command("unsafe WSL distro name", distro.clone()))?;
        let mut cmd = Command::new("wsl.exe");
        cmd.arg("-d").arg(distro);
        if let Some(cwd) = cwd.filter(|s| !s.is_empty()) {
            cmd.arg("--cd").arg(cwd);
        }
        // Host env_remove alone does not clear variables supplied by WSL.
        cmd.arg("--exec").arg("env");
        for name in ISOLATED_GIT_ENV {
            cmd.arg("-u").arg(name);
        }
        cmd.arg("GIT_NO_LAZY_FETCH=1");
        cmd.arg("git").arg("--literal-pathspecs");
        cmd.args(args);
        return Ok(cmd);
    }

    let mut cmd = Command::new("git");
    // Every path this API receives names an entry selected by the caller.
    // `--` only stops option parsing; it does not stop Git's glob expansion.
    cmd.arg("--literal-pathspecs");
    for name in ISOLATED_GIT_ENV {
        cmd.env_remove(name);
    }
    cmd.args(args);
    if let Some(dir) = cwd.filter(|s| !s.is_empty()) {
        cmd.current_dir(Path::new(dir));
    }
    Ok(cmd)
}

pub fn ensure_success(output: &GitOutput, context: &'static str) -> Result<()> {
    if output.timed_out {
        return Err(GitError::TimedOut(context));
    }
    if output.exit_code == Some(0) {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if let Some(err) = classify_auth_error(&stderr) {
        return Err(err);
    }
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "unknown git error".into()
    };
    Err(GitError::CommandFailed { context, detail })
}

fn classify_auth_error(stderr: &str) -> Option<GitError> {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("authentication failed")
        || lower.contains("permission denied (publickey)")
        || lower.contains("invalid credentials")
    {
        return Some(GitError::AuthRequired(
            stderr.lines().next().unwrap_or(stderr).to_string(),
        ));
    }
    if lower.contains("host key verification failed") {
        return Some(GitError::HostKeyUnverified);
    }
    None
}

pub(crate) fn decode_text(bytes: Vec<u8>) -> TextSource {
    let sniff_len = bytes.len().min(8192);
    if bytes[..sniff_len].contains(&0) {
        return TextSource::Binary;
    }
    match String::from_utf8(bytes) {
        Ok(text) => TextSource::Text(text),
        Err(e) => TextSource::Text(String::from_utf8_lossy(&e.into_bytes()).into_owned()),
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::build_git_command;
    use super::{
        classify_auth_error, decode_text, parse_git_version, prune_expired_availability_entries,
        version_meets_minimum, Availability, AvailabilityCache, AVAILABILITY_TTL,
    };
    use crate::modules::git::errors::GitError;
    use crate::modules::git::types::TextSource;
    use crate::modules::workspace::WorkspaceEnv;
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::time::{Duration, Instant};

    #[test]
    fn missing_entries_are_distinct_from_missing_git_objects() {
        use super::git_show_text;
        use std::process::Command;
        let dir = tempfile::tempdir().unwrap();
        let repo = std::fs::canonicalize(dir.path()).unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_string()
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "test@oarlock.local"]);
        git(&["config", "user.name", "Oarlock Test"]);
        let root = repo.to_str().unwrap();
        assert!(matches!(
            git_show_text(&WorkspaceEnv::Local, root, "HEAD:absent").unwrap(),
            TextSource::Missing
        ));
        std::fs::write(repo.join("file.txt"), "tracked text").unwrap();
        git(&["add", "file.txt"]);
        git(&["commit", "-qm", "test"]);
        assert!(matches!(
            git_show_text(&WorkspaceEnv::Local, root, "HEAD:absent").unwrap(),
            TextSource::Missing
        ));
        assert!(matches!(
            git_show_text(&WorkspaceEnv::Local, root, ":absent").unwrap(),
            TextSource::Missing
        ));
        let blob = git(&["rev-parse", "HEAD:file.txt"]);
        std::fs::remove_file(repo.join(".git/objects").join(&blob[..2]).join(&blob[2..])).unwrap();
        assert!(git_show_text(&WorkspaceEnv::Local, root, "HEAD:file.txt").is_err());
        assert!(git_show_text(&WorkspaceEnv::Local, root, ":file.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_timed_out_commit_removes_its_index_lock_and_stops_its_hooks() {
        use super::run_git;
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        let dir = tempfile::tempdir().unwrap();
        let repo = std::fs::canonicalize(dir.path()).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .expect("git on PATH");
            assert!(out.status.success(), "git {args:?} failed");
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "test@oarlock.local"]);
        git(&["config", "user.name", "Oarlock Test"]);
        git(&["config", "commit.gpgsign", "false"]);
        git(&["config", "core.hooksPath", ".git/hooks"]);
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&["add", "a.txt"]);
        let marker = repo.join("hook-finished");
        let hook = repo.join(".git/hooks/pre-commit");
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(
            &hook,
            format!(
                "#!/bin/sh\ntrap '' TERM\nsleep 2\ntouch '{}'\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

        let out = run_git(
            &WorkspaceEnv::Local,
            Some(repo.to_str().unwrap()),
            ["commit", "-m", "slow hook"],
            1,
        )
        .unwrap();
        assert!(out.timed_out);
        assert!(
            !repo.join(".git/index.lock").exists(),
            "a timed-out commit left index.lock behind"
        );
        std::thread::sleep(Duration::from_millis(2500));
        assert!(!marker.exists(), "the hook outlived the timed-out commit");
    }

    #[test]
    fn extracts_simple_version() {
        assert_eq!(
            parse_git_version("git version 2.42.0"),
            Some("2.42.0".into())
        );
    }

    #[test]
    fn extracts_apple_version() {
        assert_eq!(
            parse_git_version("git version 2.39.3 (Apple Git-145)"),
            Some("2.39.3".into())
        );
    }

    #[test]
    fn version_compare() {
        assert!(version_meets_minimum("2.23.0", "2.23"));
        assert!(version_meets_minimum("2.40.1", "2.23"));
        assert!(version_meets_minimum("3.0.0", "2.23"));
        assert!(!version_meets_minimum("2.22.0", "2.23"));
        assert!(!version_meets_minimum("1.9.5", "2.23"));
        // patch component must not regress the comparison
        assert!(version_meets_minimum("2.23.5", "2.23.4"));
        assert!(!version_meets_minimum("2.23.3", "2.23.4"));
    }

    #[test]
    fn prunes_expired_workspace_availability_entries() {
        let mut cache = HashMap::from([
            (
                "local".to_string(),
                AvailabilityCache {
                    value: Availability::Ok,
                    checked_at: Instant::now(),
                },
            ),
            (
                "wsl:Ubuntu".to_string(),
                AvailabilityCache {
                    value: Availability::NotInstalled,
                    checked_at: Instant::now() - AVAILABILITY_TTL - Duration::from_secs(1),
                },
            ),
        ]);

        prune_expired_availability_entries(&mut cache);

        assert!(cache.contains_key("local"));
        assert!(!cache.contains_key("wsl:Ubuntu"));
    }

    #[cfg(windows)]
    #[test]
    fn builds_wsl_git_command_with_cd_and_exec() {
        let cmd = build_git_command(
            &WorkspaceEnv::Wsl {
                distro: "Ubuntu".into(),
            },
            Some("/home/vinicios/Nova pasta/repo"),
            &[OsString::from("status"), OsString::from("--short")],
        )
        .expect("valid WSL distro");
        let program = cmd.get_program().to_string_lossy().into_owned();
        let args: Vec<String> = cmd
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(program, "wsl.exe");
        assert_eq!(
            &args[..6],
            &[
                "-d",
                "Ubuntu",
                "--cd",
                "/home/vinicios/Nova pasta/repo",
                "--exec",
                "env"
            ]
        );
        let git = args.iter().position(|v| v == "git").unwrap();
        for name in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
            "GIT_CONFIG_COUNT",
            "GIT_OBJECT_DIRECTORY",
            "GIT_GLOB_PATHSPECS",
        ] {
            assert!(args[6..git]
                .chunks_exact(2)
                .any(|pair| pair == ["-u", name]));
        }
        assert_eq!(
            &args[git..],
            &["git", "--literal-pathspecs", "status", "--short"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn rejects_unsafe_wsl_distro_name_for_git_command() {
        let err = build_git_command(
            &WorkspaceEnv::Wsl {
                distro: "../Ubuntu".into(),
            },
            None,
            &[],
        )
        .unwrap_err();
        assert!(err.to_string().contains("unsafe WSL distro name"));
    }

    #[test]
    fn guarded_remote_commands_keep_trusted_user_auth_and_clone_is_unchanged() {
        let clone: Vec<OsString> = [
            "-c",
            "protocol.allow=never",
            "clone",
            "--",
            "https://example.invalid/repo",
            "repo",
        ]
        .into_iter()
        .map(Into::into)
        .collect();
        let (actual, guarded) = super::defense_args(clone.clone(), &WorkspaceEnv::Local);
        assert!(guarded);
        assert!(actual.ends_with(&clone));
        assert!(actual.iter().any(|arg| arg == "core.fsmonitor=false"));
        assert!(!actual
            .iter()
            .any(|arg| arg == "credential.helper=" || arg == "core.sshCommand="));
        for verb in ["clone", "fetch", "pull", "push"] {
            let (args, guarded) =
                super::defense_args(vec![OsString::from(verb)], &WorkspaceEnv::Local);
            assert!(guarded);
            assert!(!args.iter().any(|arg| arg == "credential.helper="
                || arg == "core.sshCommand="
                || arg == "core.askPass="));
            assert!(args.iter().any(|arg| arg == "core.fsmonitor=false"));
        }
        let (args, _) = super::defense_args(vec!["status".into()], &WorkspaceEnv::Local);
        assert!(args.iter().any(|arg| arg == "credential.helper="));
    }

    #[test]
    fn detects_common_auth_failures_case_insensitively() {
        for stderr in [
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
            "error: could not read Password for 'https://example.com': No such device",
            "remote: Authentication FAILED for the repository",
            "git@github.com: Permission denied (publickey).",
            "fatal: Invalid credentials for 'https://github.com'",
        ] {
            let err = classify_auth_error(stderr).expect("auth error detected");
            assert!(matches!(err, GitError::AuthRequired(_)));
        }
    }

    #[test]
    fn host_key_verification_is_classified_separately() {
        let err = classify_auth_error(
            "@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.\nfatal: Could not read from remote repository.",
        )
        .expect("host key failure detected");
        assert!(matches!(err, GitError::HostKeyUnverified));
        assert!(!matches!(err, GitError::AuthRequired(_)));
    }

    #[test]
    fn auth_error_carries_first_stderr_line() {
        let err =
            classify_auth_error("remote: denied\nfatal: could not read username\nmore detail")
                .expect("auth error");
        match err {
            GitError::AuthRequired(line) => assert_eq!(line, "remote: denied"),
            other => panic!("expected AuthRequired, got {other:?}"),
        }
    }

    #[test]
    fn classifies_host_key_verification_failure() {
        assert!(matches!(
            classify_auth_error("fatal: Host key verification failed."),
            Some(GitError::HostKeyUnverified)
        ));
    }

    #[test]
    fn leaves_unrelated_stderr_untouched() {
        assert!(classify_auth_error(
            "fatal: not a git repository (or any of the parent directories)"
        )
        .is_none());
        assert!(classify_auth_error("").is_none());
        assert!(
            classify_auth_error("error: RPC failed because the HTTP client could not connect")
                .is_none()
        );
    }

    #[test]
    fn decode_text_flags_nulls_as_binary() {
        let mut bytes = b"hello".to_vec();
        bytes.push(0);
        bytes.extend_from_slice(b"world");
        assert!(matches!(decode_text(bytes), TextSource::Binary));
    }

    #[test]
    fn decode_text_passes_ascii_through() {
        let expected = "main\n5c2f4cd fix(ai): route status-bar AI button\n";
        let bytes = expected.as_bytes().to_vec();
        match decode_text(bytes) {
            TextSource::Text(text) => assert_eq!(text, expected),
            TextSource::Binary => panic!("expected text, got binary"),
            TextSource::Missing => panic!("expected text, got missing"),
        }
    }

    #[test]
    fn decode_text_lossy_for_invalid_utf8() {
        let bytes = vec![b'a', 0xFF, b'b'];
        match decode_text(bytes) {
            TextSource::Text(s) => assert_eq!(s, "a\u{FFFD}b"),
            TextSource::Binary => panic!("expected text, got binary"),
            TextSource::Missing => panic!("expected text, got missing"),
        }
    }

    #[test]
    fn decode_text_binary_sniff_is_bounded() {
        let mut bytes = vec![b'a'; 8192];
        bytes.push(0);
        match decode_text(bytes) {
            TextSource::Text(_) => {}
            TextSource::Binary => panic!("null beyond the sniff window must not be detected"),
            TextSource::Missing => panic!("expected text, got missing"),
        }
    }

    #[test]
    fn decode_text_null_at_sniff_boundary() {
        let mut within = vec![b'a'; 8191];
        within.push(0);
        assert!(matches!(decode_text(within), TextSource::Binary));
    }
}
