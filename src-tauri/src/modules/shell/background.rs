use std::io::Read;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::SystemTime;

use serde::Serialize;
use shared_child::SharedChild;

use super::ringbuffer::BoundedRingBuffer;
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

const RING_CAP: usize = 4 * 1024 * 1024;
const THREAD_STACK: usize = 128 * 1024;

fn spawn_thread(name: &str, work: impl FnOnce() + Send + 'static) -> Result<(), String> {
    thread::Builder::new()
        .name(name.into())
        .stack_size(THREAD_STACK)
        .spawn(work)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn pump(mut pipe: impl Read, proc: &BackgroundProc) {
    let mut buf = [0u8; 8192];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => proc.buffer.lock().unwrap().push(&buf[..n]),
        }
    }
}

pub struct BackgroundProc {
    pub chat_id: Option<String>,
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_ms: u64,
    #[cfg(windows)]
    child: Arc<SharedChild>,
    #[cfg(unix)]
    tree: Arc<crate::modules::proc::group::ProcessTree>,
    pub buffer: Mutex<BoundedRingBuffer>,
    pub exited: AtomicBool,
    killing: AtomicBool,
    pub exit_code: AtomicI32,
    pub exit_unknown: AtomicBool,
    stdin_control: bool,
    control: Mutex<Option<std::process::ChildStdin>>,
    /// Holds the process tree: closing it kills everything still inside.
    #[cfg(windows)]
    job: Mutex<Option<crate::modules::proc::job::ProcessJob>>,
}

#[derive(Serialize)]
pub struct BackgroundLogResponse {
    pub bytes: String,
    pub next_offset: u64,
    pub dropped: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

#[derive(Serialize)]
pub struct BackgroundProcInfo {
    pub handle: u32,
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_ms: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

impl BackgroundProc {
    pub fn read_logs(&self, since: u64) -> BackgroundLogResponse {
        let (bytes, next_offset, dropped) = self.buffer.lock().unwrap().read_from(since);
        let exited = self.exited.load(Ordering::Acquire);
        let exit_code = if exited && !self.exit_unknown.load(Ordering::Acquire) {
            Some(self.exit_code.load(Ordering::Acquire))
        } else {
            None
        };
        BackgroundLogResponse {
            bytes: String::from_utf8_lossy(&bytes).into_owned(),
            next_offset,
            dropped,
            exited,
            exit_code,
        }
    }

    /// Stops the process with everything it started: a dev server's shell
    /// alone would leave the server running and holding its port. On Unix the
    /// process leads its own group, which gets SIGTERM and, after
    /// `TERM_GRACE`, SIGKILL; on Windows its job is closed.
    pub fn kill(&self) {
        if self.exited.load(Ordering::Acquire) || self.killing.swap(true, Ordering::AcqRel) {
            return;
        }
        if self.stdin_control {
            drop(
                self.control
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take(),
            );
            return;
        }
        #[cfg(unix)]
        {
            let tree = self.tree.clone();
            if spawn_thread("oarlock-bg-kill", move || tree.stop()).is_err() {
                self.tree.stop();
            }
        }
        #[cfg(windows)]
        drop(self.job.lock().unwrap().take());
        #[cfg(windows)]
        let _ = self.child.kill();
    }

    /// App exit cannot leave the asynchronous kill worker behind.
    #[cfg(unix)]
    pub fn finish_kill(&self) {
        self.tree.stop();
    }

    pub fn info(&self, handle: u32) -> BackgroundProcInfo {
        let exited = self.exited.load(Ordering::Acquire);
        let exit_code = if exited && !self.exit_unknown.load(Ordering::Acquire) {
            Some(self.exit_code.load(Ordering::Acquire))
        } else {
            None
        };
        BackgroundProcInfo {
            handle,
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            started_at_ms: self.started_at_ms,
            exited,
            exit_code,
        }
    }
}

impl Drop for BackgroundProc {
    fn drop(&mut self) {
        self.kill();
    }
}

pub fn spawn(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
) -> Result<Arc<BackgroundProc>, String> {
    spawn_owned(command, cwd, workspace, None)
}

pub fn spawn_owned(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    chat_id: Option<String>,
) -> Result<Arc<BackgroundProc>, String> {
    spawn_notifying(command, cwd, workspace, chat_id, || {})
}

pub(super) fn spawn_notifying(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    chat_id: Option<String>,
    on_exit: impl FnOnce() + Send + 'static,
) -> Result<Arc<BackgroundProc>, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    if let Some(ref dir) = cwd {
        if !resolve_path(dir, &workspace)?.is_dir() {
            return Err(format!("cwd is not a directory: {dir}"));
        }
    }

    let (mut cmd, stdin_control) =
        super::build_managed_command(&trimmed, &workspace, cwd.as_deref(), true)?;
    if let (WorkspaceEnv::Local, Some(ref dir)) = (&workspace, &cwd) {
        cmd.current_dir(dir);
    }
    cmd.stdin(if stdin_control {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    #[cfg(not(windows))]
    let shared = Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| e.to_string())?);
    #[cfg(windows)]
    let (shared, job) = if stdin_control {
        (
            Arc::new(SharedChild::spawn(&mut cmd).map_err(|e| e.to_string())?),
            None,
        )
    } else {
        let (child, job) =
            crate::modules::proc::job::spawn_tree(&mut cmd).map_err(|e| e.to_string())?;
        (Arc::new(child), Some(job))
    };
    let kill_on_fail = || {
        let _ = shared.kill();
    };
    let stdout_pipe = shared.take_stdout().ok_or_else(|| {
        kill_on_fail();
        "no stdout pipe".to_string()
    })?;
    let stderr_pipe = shared.take_stderr().ok_or_else(|| {
        kill_on_fail();
        "no stderr pipe".to_string()
    })?;
    let child = shared;

    let started_at_ms = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let control = if stdin_control {
        child.take_stdin()
    } else {
        None
    };
    let proc = Arc::new(BackgroundProc {
        chat_id,
        stdin_control,
        control: Mutex::new(control),
        command: trimmed,
        cwd,
        started_at_ms,
        #[cfg(unix)]
        tree: Arc::new(crate::modules::proc::group::ProcessTree::new(child.clone())),
        #[cfg(windows)]
        child,
        buffer: Mutex::new(BoundedRingBuffer::new(RING_CAP)),
        exited: AtomicBool::new(false),
        killing: AtomicBool::new(false),
        exit_code: AtomicI32::new(0),
        exit_unknown: AtomicBool::new(false),
        #[cfg(windows)]
        job: Mutex::new(job),
    });

    let fail = |error: String| {
        proc.kill();
        #[cfg(unix)]
        let _ = proc.tree.foreground(std::time::Duration::ZERO);
        #[cfg(windows)]
        let _ = proc.child.wait();
        error
    };
    let mut drained = Vec::with_capacity(2);
    for (name, pipe) in [
        (
            "oarlock-bg-out",
            Box::new(stdout_pipe) as Box<dyn Read + Send>,
        ),
        (
            "oarlock-bg-err",
            Box::new(stderr_pipe) as Box<dyn Read + Send>,
        ),
    ] {
        let proc_ref = proc.clone();
        let (done, receiver) = std::sync::mpsc::channel();
        spawn_thread(name, move || {
            pump(pipe, &proc_ref);
            let _ = done.send(());
        })
        .map_err(fail)?;
        drained.push(receiver);
    }
    {
        let proc_ref = proc.clone();
        #[cfg(windows)]
        let child_for_wait = proc.child.clone();
        spawn_thread("oarlock-bg-wait", move || {
            #[cfg(unix)]
            let result = proc_ref.tree.background();
            #[cfg(windows)]
            let result = child_for_wait.wait().and_then(|status| {
                loop {
                    let active = proc_ref
                        .job
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map(|job| job.active_processes())
                        .transpose()?
                        .unwrap_or(0);
                    if active == 0 {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
                Ok(status)
            });
            match result {
                Ok(status) => match status.code() {
                    Some(code) => proc_ref.exit_code.store(code, Ordering::Release),
                    None => proc_ref.exit_unknown.store(true, Ordering::Release),
                },
                Err(_) => {
                    proc_ref.kill();
                    proc_ref.exit_unknown.store(true, Ordering::Release);
                }
            }
            // A caller stops polling when exited becomes true. Publish it only
            // after the final pipe bytes reach the log buffer. Escaped programs
            // holding a pipe cannot keep the managed job open forever.
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(750);
            for receiver in drained {
                let _ = receiver
                    .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()));
            }
            proc_ref.exited.store(true, Ordering::Release);
            on_exit();
        })
        .map_err(fail)?;
    }

    Ok(proc)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn wait_for_exit(proc: &BackgroundProc) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !proc.exited.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "the process outlived kill");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn exited_shell_keeps_its_descendants_managed_and_stoppable() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("survived");
        let proc = spawn(
            format!(
                "(sleep 2; touch '{}') & printf ready; exit 7",
                marker.display()
            ),
            None,
            WorkspaceEnv::Local,
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !proc.read_logs(0).bytes.contains("ready") {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(Duration::from_millis(150));
        assert!(
            !proc.read_logs(0).exited,
            "the child still belongs to this job"
        );
        proc.kill();
        wait_for_exit(&proc);
        thread::sleep(Duration::from_millis(2100));
        assert!(!marker.exists(), "the orphaned child survived cancellation");
    }

    #[test]
    fn completion_waits_for_the_last_log_bytes() {
        let proc = spawn(
            "sleep 0.1; printf last-line".into(),
            None,
            WorkspaceEnv::Local,
        )
        .unwrap();
        let buffer = proc.buffer.lock().unwrap();
        thread::sleep(Duration::from_millis(350));
        assert!(
            !proc.exited.load(Ordering::Acquire),
            "exit raced ahead of the blocked log reader"
        );
        drop(buffer);
        wait_for_exit(&proc);
        assert!(proc.read_logs(0).bytes.contains("last-line"));
    }

    #[test]
    fn background_finishes_only_after_descendants_and_preserves_shell_status() {
        let proc = spawn(
            "(sleep 0.4; printf finished) & exit 7".into(),
            None,
            WorkspaceEnv::Local,
        )
        .unwrap();
        wait_for_exit(&proc);
        assert_eq!(proc.read_logs(0).exit_code, Some(7));
        assert!(proc.read_logs(0).bytes.contains("finished"));
        proc.kill(); // A completed job never signals its old process group.
    }

    #[test]
    fn kill_takes_what_the_process_started_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("survived");
        let script = format!(
            "(trap '' TERM; sleep 1; touch '{}') & wait",
            marker.display()
        );
        let proc = spawn(script, None, WorkspaceEnv::Local).unwrap();
        thread::sleep(Duration::from_millis(200));
        proc.kill();
        wait_for_exit(&proc);
        thread::sleep(Duration::from_millis(1500));
        assert!(!marker.exists(), "a grandchild outlived kill");
    }

    #[test]
    fn kill_gives_the_process_a_chance_to_clean_up() {
        let proc = spawn(
            "trap 'printf cleaned; exit 1' TERM; sleep 30 & wait".into(),
            None,
            WorkspaceEnv::Local,
        )
        .unwrap();
        thread::sleep(Duration::from_millis(200));
        proc.kill();
        wait_for_exit(&proc);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !proc.read_logs(0).bytes.contains("cleaned") {
            assert!(Instant::now() < deadline, "no output from the TERM trap");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn kill_after_exit_is_harmless() {
        let proc = spawn("exit 0".into(), None, WorkspaceEnv::Local).unwrap();
        wait_for_exit(&proc);
        proc.kill();
        assert_eq!(proc.read_logs(0).exit_code, Some(0));
    }
}
