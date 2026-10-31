use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

use super::run_cancellable;
use crate::modules::fs::to_canon;
use crate::modules::proc::capture::Cancellation;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

pub struct ShellSession {
    pub chat_id: Option<String>,
    pub cwd: Mutex<String>,
    pub workspace: WorkspaceEnv,
    pub pristine: AtomicBool,
    pub cancellation: Cancellation,
    #[allow(dead_code)]
    pub started_at_ms: u64,
    sentinel: String,
    run_lock: Mutex<()>,
    cwd_known: AtomicBool,
}

#[derive(Serialize)]
pub struct SessionRunOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
    pub cwd_after: Option<String>,
    pub cwd_error: Option<String>,
}

// Sentinel is randomized per session so untrusted command stdout can't spoof a
// cwd update by emitting the marker literal.
const CWD_UNKNOWN: &str = "The command did not report a valid working directory. This shell cannot be reused; send /stop to reset the chat's shells before running another command. The command may already have completed.";

static SENTINEL_COUNTER: AtomicU64 = AtomicU64::new(0);

fn generate_sentinel() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let counter = SENTINEL_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id() as u64;
    let mix = nanos ^ counter.rotate_left(17) ^ pid.rotate_left(31);
    format!("__OARLOCK_CWD_{:016x}_{:016x}__", mix, counter)
}

impl ShellSession {
    pub fn new(initial_cwd: String, workspace: WorkspaceEnv) -> Self {
        let started_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Self {
            chat_id: None,
            cwd: Mutex::new(initial_cwd),
            workspace,
            pristine: AtomicBool::new(true),
            cancellation: Cancellation::default(),
            started_at_ms,
            sentinel: generate_sentinel(),
            run_lock: Mutex::new(()),
            cwd_known: AtomicBool::new(true),
        }
    }

    pub fn current_cwd(&self) -> String {
        self.cwd.lock().unwrap().clone()
    }

    pub fn validate_workspace(&self, hint: Option<&WorkspaceEnv>) -> Result<(), String> {
        if hint.is_some_and(|hint| hint != &self.workspace) {
            return Err(
                "The shell belongs to a different environment; open a new shell session.".into(),
            );
        }
        Ok(())
    }

    /// Blocks until the command exits or times out; call from the blocking pool.
    pub fn run(
        &self,
        command: String,
        cwd_hint: Option<String>,
        workspace_hint: Option<WorkspaceEnv>,
        timeout: Duration,
    ) -> Result<SessionRunOutput, String> {
        if self.cancellation.is_requested() {
            return Err("shell command cancelled".into());
        }
        let _run = self.run_lock.lock().unwrap_or_else(|e| e.into_inner());
        if self.cancellation.is_requested() {
            return Err("shell command cancelled".into());
        }
        if !self.cwd_known.load(Ordering::Acquire) {
            return Err(CWD_UNKNOWN.into());
        }
        self.validate_workspace(workspace_hint.as_ref())?;
        let trimmed = command.trim().to_string();
        if trimmed.is_empty() {
            return Err("empty command".into());
        }
        if self.pristine.load(Ordering::Acquire) {
            if let Some(hint) = cwd_hint.filter(|s| !s.is_empty()) {
                let p = resolve_path(&hint, &self.workspace)?;
                if p.is_dir() {
                    *self.cwd.lock().unwrap() = hint;
                }
            }
        }
        let cwd = self.current_cwd();
        let wrapped = wrap_with_sentinel(&trimmed, &self.workspace, &self.sentinel)?;

        let frame = Arc::new(Mutex::new(super::cwd_frame::CwdFrame::new(&self.sentinel)));
        let observed = frame.clone();
        self.cwd_known.store(false, Ordering::Release);
        let raw = run_cancellable(
            wrapped,
            Some(cwd.clone()),
            self.workspace.clone(),
            timeout,
            Some(&self.cancellation),
            Some(Arc::new(move |bytes| {
                observed
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(bytes)
            })),
        )?;
        self.pristine.store(false, Ordering::Release);

        let recovered = frame.lock().unwrap_or_else(|e| e.into_inner()).value.take();
        let resolved_cwd = recovered.filter(|path| {
            resolve_path(path, &self.workspace).is_ok_and(|resolved| resolved.is_dir())
        });
        if let Some(path) = &resolved_cwd {
            *self.cwd.lock().unwrap() = path.clone();
            self.cwd_known.store(true, Ordering::Release);
        }
        let stdout_clean = strip_cwd_sentinel(&raw.stdout, &self.sentinel);
        Ok(SessionRunOutput {
            stdout: stdout_clean,
            stderr: raw.stderr,
            exit_code: raw.exit_code,
            timed_out: raw.timed_out,
            truncated: raw.truncated,
            cwd_error: resolved_cwd.is_none().then(|| CWD_UNKNOWN.into()),
            cwd_after: resolved_cwd.map(to_canon),
        })
    }
}

fn wrap_posix_with_sentinel(command: &str, sentinel: &str) -> String {
    format!(
        "{command}\n__oarlock_rc=$?\n__oarlock_cwd=$(pwd -P && printf .)\nprintf '\\n%s%s\\0' '{sentinel}' \"${{__oarlock_cwd%??}}\"\nexit $__oarlock_rc\n",
    )
}

fn wrap_with_sentinel(
    command: &str,
    workspace: &WorkspaceEnv,
    sentinel: &str,
) -> Result<String, String> {
    if workspace.is_wsl() {
        return Ok(wrap_posix_with_sentinel(command, sentinel));
    }
    #[cfg(unix)]
    {
        Ok(wrap_posix_with_sentinel(command, sentinel))
    }
    #[cfg(windows)]
    {
        let shell = crate::modules::pty::shell_init::windows_shell_path();
        if shell
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("cmd.exe"))
        {
            return Err("Persistent AI shells require PowerShell; cmd.exe cannot report working-directory metadata safely.".into());
        }
        // Write control bytes directly: Windows PowerShell's console codepage
        // cannot represent every valid path, while the metadata protocol is UTF-8.
        Ok(format!(
            "{command}\n$__oarlock_rc = if ($null -ne $LASTEXITCODE) {{ $LASTEXITCODE }} elseif ($?) {{ 0 }} else {{ 1 }}\n[Console]::Out.Flush()\n$__oarlock_meta = [Text.Encoding]::UTF8.GetBytes(\"`n{sentinel}$($PWD.Path)\" + [char]0)\n[Console]::OpenStandardOutput().Write($__oarlock_meta, 0, $__oarlock_meta.Length)\nexit $__oarlock_rc\n",
        ))
    }
}

fn strip_cwd_sentinel(stdout: &str, sentinel: &str) -> String {
    let marker = format!("\n{sentinel}");
    let Some((before, rest)) = stdout.split_once(&marker) else {
        return stdout.to_owned();
    };
    // PowerShell's output formatter or a child can flush output after metadata.
    // Remove only the frame, preserving later command output if present.
    let after = rest.split_once('\0').map_or("", |(_, after)| after);
    format!("{before}{after}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stripping_metadata_preserves_later_output() {
        assert_eq!(
            strip_cwd_sentinel("before\nMARK/path\0after", "MARK"),
            "beforeafter"
        );
        assert_eq!(
            strip_cwd_sentinel("before\nMARK/truncated", "MARK"),
            "before"
        );
    }
    #[cfg(windows)]
    #[test]
    fn powershell_cwd_metadata_preserves_unicode_paths() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("unicode-é-雪");
        std::fs::create_dir(&sub).unwrap();
        let session = ShellSession::new(dir.path().to_string_lossy().into(), WorkspaceEnv::Local);
        let result = session
            .run(
                "Set-Location -LiteralPath 'unicode-é-雪'".into(),
                None,
                None,
                Duration::from_secs(10),
            )
            .unwrap();
        assert!(result.cwd_error.is_none(), "{:?}", result.cwd_error);
        assert_eq!(
            std::fs::canonicalize(result.cwd_after.unwrap()).unwrap(),
            std::fs::canonicalize(sub).unwrap()
        );
    }
    #[cfg(unix)]
    #[test]
    fn cwd_is_recovered_after_truncation_and_used_by_the_next_command() {
        let dir = tempfile::tempdir().unwrap();
        let next = dir.path().join("sub");
        std::fs::create_dir(&next).unwrap();
        let session = ShellSession::new(dir.path().to_string_lossy().into(), WorkspaceEnv::Local);
        let result = session
            .run(
                "cd sub; head -c 300000 /dev/zero | tr '\\0' x".into(),
                None,
                None,
                Duration::from_secs(5),
            )
            .unwrap();
        assert!(result.truncated);
        assert!(result.stdout.len() <= 256 * 1024);
        assert!(result.cwd_error.is_none());
        assert_eq!(
            std::fs::canonicalize(result.cwd_after.unwrap()).unwrap(),
            std::fs::canonicalize(&next).unwrap()
        );
        let result = session
            .run(
                "printf correct > marker".into(),
                None,
                None,
                Duration::from_secs(5),
            )
            .unwrap();
        assert!(result.cwd_error.is_none());
        assert!(next.join("marker").exists());
    }
    #[cfg(unix)]
    #[test]
    fn unknown_cwd_keeps_output_but_prevents_reuse() {
        for command in ["printf useful; exit 7", "exec printf useful"] {
            let dir = tempfile::tempdir().unwrap();
            let session =
                ShellSession::new(dir.path().to_string_lossy().into(), WorkspaceEnv::Local);
            let result = session
                .run(command.into(), None, None, Duration::from_secs(5))
                .unwrap();
            assert_eq!(result.stdout, "useful");
            assert!(result.cwd_after.is_none());
            assert!(result.cwd_error.is_some());
            assert!(session
                .run(
                    "touch should-not-run".into(),
                    None,
                    None,
                    Duration::from_secs(5)
                )
                .is_err());
            assert!(!dir.path().join("should-not-run").exists());
        }
    }
    #[cfg(unix)]
    #[test]
    fn timeout_without_cwd_metadata_prevents_reuse() {
        let dir = tempfile::tempdir().unwrap();
        let session = ShellSession::new(dir.path().to_string_lossy().into(), WorkspaceEnv::Local);
        let result = session
            .run("sleep 30".into(), None, None, Duration::from_millis(100))
            .unwrap();
        assert!(result.timed_out);
        assert!(result.cwd_after.is_none());
        assert!(result.cwd_error.is_some());
        assert!(session
            .run(
                "touch should-not-run".into(),
                None,
                None,
                Duration::from_secs(5)
            )
            .is_err());
        assert!(!dir.path().join("should-not-run").exists());
    }
    #[cfg(unix)]
    #[test]
    fn cwd_preserves_trailing_spaces_and_newlines() {
        let dir = tempfile::tempdir().unwrap();
        let next = dir.path().join("space \n");
        std::fs::create_dir(&next).unwrap();
        let session = ShellSession::new(dir.path().to_string_lossy().into(), WorkspaceEnv::Local);
        let result = session
            .run(
                "cd 'space \n'; printf output".into(),
                None,
                None,
                Duration::from_secs(5),
            )
            .unwrap();
        assert_eq!(result.stdout, "output");
        assert_eq!(
            std::fs::canonicalize(result.cwd_after.unwrap()).unwrap(),
            std::fs::canonicalize(next).unwrap()
        );
    }
    #[test]
    fn workspace_hints_must_match_the_bound_environment() {
        let session = ShellSession::new(
            "/project".into(),
            WorkspaceEnv::Wsl {
                distro: "Ubuntu".into(),
            },
        );
        assert!(session.validate_workspace(None).is_ok());
        assert!(session
            .validate_workspace(Some(&WorkspaceEnv::Wsl {
                distro: "Ubuntu".into()
            }))
            .is_ok());
        assert!(session
            .validate_workspace(Some(&WorkspaceEnv::Wsl {
                distro: "Debian".into()
            }))
            .is_err());
        assert!(session
            .validate_workspace(Some(&WorkspaceEnv::Local))
            .is_err());
        let host = ShellSession::new("/project".into(), WorkspaceEnv::Local);
        assert!(host.validate_workspace(Some(&session.workspace)).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn a_session_cannot_be_retargeted_to_another_environment() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("wrong-environment");
        let session = ShellSession::new(
            dir.path().to_string_lossy().into(),
            WorkspaceEnv::Wsl {
                distro: "OwnedDistro".into(),
            },
        );
        let result = session.run(
            format!("touch '{}'", marker.display()),
            None,
            Some(WorkspaceEnv::Local),
            Duration::from_secs(2),
        );
        assert!(result.is_err(), "a WSL-owned session executed on the host");
        assert!(!marker.exists());
    }
    #[test]
    fn sentinels_are_unique_per_session() {
        let a = ShellSession::new("/tmp".into(), WorkspaceEnv::Local);
        let b = ShellSession::new("/tmp".into(), WorkspaceEnv::Local);
        assert_ne!(a.sentinel, b.sentinel);
        assert!(a.sentinel.starts_with("__OARLOCK_CWD_"));
        assert!(a.sentinel.ends_with("__"));
        assert!(a.sentinel.len() > 20);
    }

    #[test]
    fn wrap_embeds_session_sentinel() {
        let s = ShellSession::new("/tmp".into(), WorkspaceEnv::Local);
        let wrapped = wrap_with_sentinel("echo hi", &WorkspaceEnv::Local, &s.sentinel).unwrap();
        assert!(wrapped.contains(&s.sentinel));
    }
}
