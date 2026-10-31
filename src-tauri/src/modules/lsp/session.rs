use std::io::{Read, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use shared_child::SharedChild;
use tauri::ipc::{Channel, Response};
use tauri::Manager;

use super::framing::{encode_frame, FrameDecoder};

pub(super) const MAX_WRITE_BYTES: usize = 16 * 1024 * 1024;
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

const READ_BUF: usize = 32 * 1024;
const STDERR_LINE_CAP: usize = 512;
const STDERR_TAIL_LINES: usize = 8;
const MEM_POLL_INTERVAL: Duration = Duration::from_secs(30);
// Workspace loading transiently peaks far above steady state; only police
// steady state.
const MEM_STARTUP_GRACE: Duration = Duration::from_secs(120);
const DEFAULT_MAX_RSS_MB: u64 = 4096;
// Pipe pumps and the waiter only shuffle bytes, so they need very little stack.
const THREAD_STACK: usize = 256 * 1024;

fn spawn_thread(
    name: String,
    work: impl FnOnce() + Send + 'static,
) -> Result<thread::JoinHandle<()>, String> {
    thread::Builder::new()
        .name(name)
        .stack_size(THREAD_STACK)
        .spawn(work)
        .map_err(|e| e.to_string())
}

/// Resident size in whole MB when it exceeds the budget.
fn over_budget(rss_bytes: u64, cap_mb: u64) -> Option<u64> {
    let rss_mb = rss_bytes / (1024 * 1024);
    (rss_mb > cap_mb).then_some(rss_mb)
}

/// When the next memory check is due: once after the startup grace, then on
/// the steady-state interval.
fn next_memory_check(now: Instant, first: bool) -> Instant {
    now + if first {
        MEM_STARTUP_GRACE
    } else {
        MEM_POLL_INTERVAL
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspExit {
    pub code: Option<i32>,
    pub stderr_tail: String,
    pub reason: Option<String>,
}

pub struct LspSession {
    #[cfg(windows)]
    _job: Option<crate::modules::proc::job::ProcessJob>,
    child: Arc<SharedChild>,
    stdin: Mutex<Option<ChildStdin>>,
    stopping: AtomicBool,
    writing: AtomicBool,
    kill_reason: Arc<Mutex<Option<String>>>,
    pub(super) exited: Arc<AtomicBool>,
}

struct WritePermit(Arc<LspSession>);
impl Drop for WritePermit {
    fn drop(&mut self) {
        self.0.writing.store(false, Ordering::Release);
    }
}

impl LspSession {
    fn stop_for_write(&self, reason: String) -> String {
        let mut saved = self.kill_reason.lock().unwrap();
        if saved.is_none() {
            *saved = Some(reason.clone());
        }
        drop(saved);
        self.kill();
        reason
    }

    pub async fn send(self: &Arc<Self>, message: String) -> Result<(), String> {
        self.send_with_timeout(message, WRITE_TIMEOUT).await
    }

    async fn send_with_timeout(
        self: &Arc<Self>,
        message: String,
        timeout: Duration,
    ) -> Result<(), String> {
        if message.len() > MAX_WRITE_BYTES {
            return Err(self.stop_for_write(
                "Language server write exceeds 16 MiB. Restart the language server.".into(),
            ));
        }
        if self.stopping.load(Ordering::Acquire) {
            return Err("lsp session is stopping".into());
        }
        if self
            .writing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(self.stop_for_write(
                "Concurrent language server writes refused. Restart the language server.".into(),
            ));
        }
        let permit = WritePermit(self.clone());
        let writing = tauri::async_runtime::spawn_blocking(move || {
            let result = permit.0.write_message(&message);
            drop(permit);
            result
        });
        match tokio::time::timeout(timeout, writing).await {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(error))) => Err(self.stop_for_write(error)),
            Ok(Err(error)) => {
                Err(self.stop_for_write(format!("Language server writer failed: {error}")))
            }
            Err(_) => Err(self.stop_for_write(
                "Language server write stalled for 30 seconds. Restart the language server.".into(),
            )),
        }
    }

    pub fn write_message(&self, payload: &str) -> Result<(), String> {
        if self.stopping.load(Ordering::Acquire) {
            return Err("lsp session is stopping".into());
        }
        let mut guard = self.stdin.lock().unwrap();
        if self.stopping.load(Ordering::Acquire) {
            *guard = None;
            return Err("lsp session is stopping".into());
        }
        let stdin = guard.as_mut().ok_or("lsp session stdin closed")?;
        let result = stdin
            .write_all(&encode_frame(payload))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("lsp write failed: {e}"));
        if self.stopping.load(Ordering::Acquire) {
            *guard = None;
        }
        result
    }

    // Servers fork helpers (cargo check, rustc, proc-macro hosts); killing
    // only the leader leaves them burning CPU. Unix: signal the process
    // group. Windows: the Job Object covers the tree.
    pub fn kill(&self) {
        if self.stopping.swap(true, Ordering::AcqRel) {
            return;
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as libc::pid_t), libc::SIGKILL);
        }
        #[cfg(windows)]
        if let Some(job) = &self._job {
            if let Err(error) = job.terminate() {
                log::warn!("lsp process-tree termination failed: {error}");
            }
        }
        let _ = self.child.kill();
        // A full pipe holds this mutex. Stop must not wait on server input;
        // the active writer closes its handle when termination releases it.
        if let Ok(mut stdin) = self.stdin.try_lock() {
            *stdin = None;
        }
    }
}

impl Drop for LspSession {
    fn drop(&mut self) {
        self.kill();
    }
}

#[allow(clippy::too_many_arguments)]
pub fn spawn(
    id: u32,
    app: tauri::AppHandle,
    binary: &std::path::Path,
    args: &[String],
    server_env: &super::env::ServerEnv,
    extra_env: &std::collections::HashMap<String, String>,
    root: &std::path::Path,
    max_rss_mb: Option<u64>,
    on_message: Channel<Response>,
    on_exit: Channel<LspExit>,
) -> Result<Arc<LspSession>, String> {
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .current_dir(root)
        .envs(server_env)
        .envs(extra_env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }

    let child = Arc::new(
        SharedChild::spawn(&mut cmd)
            .map_err(|e| format!("lsp spawn failed for {}: {e}", binary.display()))?,
    );
    let kill_on_fail = || {
        let _ = child.kill();
    };
    let stdin = child.take_stdin().ok_or_else(|| {
        kill_on_fail();
        "lsp: no stdin pipe".to_string()
    })?;
    let mut stdout = child.take_stdout().ok_or_else(|| {
        kill_on_fail();
        "lsp: no stdout pipe".to_string()
    })?;
    let mut stderr = child.take_stderr().ok_or_else(|| {
        kill_on_fail();
        "lsp: no stderr pipe".to_string()
    })?;

    #[cfg(windows)]
    let job = match crate::modules::proc::job::ProcessJob::create_for(child.id()) {
        Ok(j) => Some(j),
        Err(e) => {
            log::warn!("lsp job-object setup failed for pid={}: {e}", child.id());
            None
        }
    };

    let kill_reason: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let exited = Arc::new(AtomicBool::new(false));
    let session = Arc::new(LspSession {
        #[cfg(windows)]
        _job: job,
        child: child.clone(),
        stdin: Mutex::new(Some(stdin)),
        stopping: AtomicBool::new(false),
        writing: AtomicBool::new(false),
        kill_reason: kill_reason.clone(),
        exited: exited.clone(),
    });

    let session_reader = session.clone();
    let reader_thread = spawn_thread(format!("oarlock-lsp-reader-{id}"), move || {
        let mut decoder = FrameDecoder::default();
        let mut buf = [0u8; READ_BUF];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => match decoder.push(&buf[..n]) {
                    Ok(messages) => {
                        for msg in messages {
                            if on_message.send(Response::new(msg.into_bytes())).is_err() {
                                log::info!("lsp id={id}: channel closed; killing server");
                                session_reader.kill();
                                return;
                            }
                        }
                    }
                    Err(e) => {
                        log::error!("lsp id={id}: {e}; killing server");
                        session_reader.kill();
                        return;
                    }
                },
                Err(e) => {
                    log::debug!("lsp id={id} stdout ended: {e}");
                    break;
                }
            }
        }
    })?;

    let stderr_tail: Arc<Mutex<std::collections::VecDeque<String>>> =
        Arc::new(Mutex::new(std::collections::VecDeque::new()));
    let stderr_tail_w = stderr_tail.clone();
    spawn_thread(format!("oarlock-lsp-stderr-{id}"), move || {
        let mut buf = [0u8; 4096];
        let mut line: Vec<u8> = Vec::new();
        let push_line = |line: &mut Vec<u8>| {
            if line.is_empty() {
                return;
            }
            let text = String::from_utf8_lossy(line).into_owned();
            log::debug!("lsp id={id} stderr: {text}");
            let mut tail = stderr_tail_w.lock().unwrap();
            if tail.len() >= STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(text);
            line.clear();
        };
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 {
                break;
            }
            for &b in &buf[..n] {
                if b == b'\n' {
                    push_line(&mut line);
                } else if line.len() < STDERR_LINE_CAP {
                    line.push(b);
                }
            }
        }
        push_line(&mut line);
    })?;

    let cap_mb = max_rss_mb.unwrap_or(DEFAULT_MAX_RSS_MB);
    let pid = child.id();
    let session_w = session.clone();
    let child_waiter = child;
    let exited_w = exited;
    // One thread both reaps the server and polices its memory: the wait is a
    // timed condvar sleep, so an idle server costs two wakeups per minute and
    // no dedicated polling thread.
    spawn_thread(format!("oarlock-lsp-waiter-{id}"), move || {
        let mut check_at = next_memory_check(Instant::now(), true);
        let code = loop {
            match child_waiter.wait_deadline(check_at) {
                Ok(Some(status)) => break status.code(),
                Ok(None) => {
                    if let Some(rss) = crate::modules::proc::rss::rss_bytes(pid) {
                        if let Some(rss_mb) = over_budget(rss, cap_mb) {
                            log::warn!(
                                "lsp id={id} rss {rss_mb} MB over budget {cap_mb} MB; killing"
                            );
                            *kill_reason.lock().unwrap() = Some(format!(
                                "Killed after exceeding the {cap_mb} MB memory budget ({rss_mb} MB resident)."
                            ));
                            session_w.kill();
                        }
                    }
                    check_at = next_memory_check(Instant::now(), false);
                }
                Err(e) => {
                    log::warn!("lsp id={id} wait failed: {e}");
                    break None;
                }
            }
        };
        exited_w.store(true, Ordering::Release);
        // Bounded, not join: a grandchild inheriting stdout keeps the
        // pipe open past child exit and would hang us.
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline && !reader_thread.is_finished() {
            thread::sleep(Duration::from_millis(10));
        }
        if let Some(state) = app.try_state::<super::LspState>() {
            state.take(id);
        }
        log::info!("lsp id={id} exited code={code:?}");
        let tail: Vec<String> = stderr_tail.lock().unwrap().iter().cloned().collect();
        let exit = LspExit {
            code,
            stderr_tail: tail.join("\n"),
            reason: kill_reason.lock().unwrap().take(),
        };
        if on_exit.send(exit).is_err() {
            log::debug!("lsp id={id} exit send failed (channel closed)");
        }
    })?;

    Ok(session)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn dummy_session(child: Arc<SharedChild>, stdin: Option<ChildStdin>) -> LspSession {
        LspSession {
            child,
            stdin: Mutex::new(stdin),
            stopping: AtomicBool::new(false),
            writing: AtomicBool::new(false),
            kill_reason: Arc::new(Mutex::new(None)),
            exited: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn memory_checks_wait_out_the_grace_then_settle_to_the_slow_interval() {
        let now = Instant::now();
        assert_eq!(next_memory_check(now, true), now + MEM_STARTUP_GRACE);
        assert_eq!(next_memory_check(now, false), now + MEM_POLL_INTERVAL);
        assert!(MEM_STARTUP_GRACE > MEM_POLL_INTERVAL);
    }

    #[test]
    fn budget_is_enforced_in_whole_megabytes() {
        let mb = 1024 * 1024;
        assert_eq!(over_budget(4096 * mb, 4096), None);
        assert_eq!(over_budget(4096 * mb + mb - 1, 4096), None);
        assert_eq!(over_budget(4097 * mb, 4096), Some(4097));
    }

    #[test]
    fn a_deadline_wait_returns_at_the_deadline_without_a_polling_loop() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30"]);
        let child = SharedChild::spawn(&mut cmd).expect("spawn");
        let started = Instant::now();
        let waited = child
            .wait_deadline(started + Duration::from_millis(150))
            .expect("wait");
        assert!(waited.is_none());
        assert!(started.elapsed() >= Duration::from_millis(140));
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn drop_kills_child() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30"]).stdin(Stdio::piped());
        let child = Arc::new(SharedChild::spawn(&mut cmd).expect("spawn"));
        let stdin = child.take_stdin();
        let session = dummy_session(child.clone(), stdin);

        assert!(child.try_wait().expect("try_wait").is_none());
        drop(session);

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if child.try_wait().expect("try_wait").is_some() {
                break;
            }
            assert!(Instant::now() < deadline, "child alive 2s after drop");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn kill_takes_down_process_group() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30 & echo $!; wait"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        unsafe {
            use std::os::unix::process::CommandExt;
            cmd.pre_exec(|| {
                libc::setpgid(0, 0);
                Ok(())
            });
        }
        let child = Arc::new(SharedChild::spawn(&mut cmd).expect("spawn"));
        let stdin = child.take_stdin();
        let mut stdout = child.take_stdout().expect("stdout");

        let mut buf = [0u8; 32];
        let n = stdout.read(&mut buf).expect("read grandchild pid");
        let grandchild: i32 = String::from_utf8_lossy(&buf[..n])
            .trim()
            .parse()
            .expect("pid");

        let session = dummy_session(child.clone(), stdin);
        session.kill();
        let _ = child.wait();

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let alive = unsafe { libc::kill(grandchild, 0) } == 0;
            if !alive {
                break;
            }
            assert!(Instant::now() < deadline, "grandchild survived group kill",);
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn releasing_one_window_terminates_only_its_language_server() {
        let state = super::super::LspState::default();
        let make = || {
            let mut cmd = Command::new("/bin/sleep");
            cmd.arg("30").stdin(Stdio::piped());
            let child = Arc::new(SharedChild::spawn(&mut cmd).unwrap());
            let session = Arc::new(dummy_session(child.clone(), child.take_stdin()));
            (child, session)
        };
        let (a, session_a) = make();
        let (b, session_b) = make();
        {
            let mut registry = state.sessions.write().unwrap();
            registry.reserve(1, "a", "page-a", "rust", 0).unwrap();
            registry.publish(1, session_a).unwrap();
            registry.reserve(2, "b", "page-b", "rust", 0).unwrap();
            registry.publish(2, session_b).unwrap();
        }
        state.release_window("a");
        let stopped = a
            .wait_deadline(Instant::now() + Duration::from_secs(2))
            .unwrap()
            .is_some();
        let other_running = b.try_wait().unwrap().is_none();
        // Always clean up both processes before reporting assertions.
        state.kill_all();
        let _ = a.kill();
        let _ = a.wait();
        let _ = b.wait();
        assert!(stopped, "closing the owner left its language server alive");
        assert!(
            other_running,
            "closing one window killed another window's server"
        );
    }

    fn sleeping_writer() -> (Arc<SharedChild>, Arc<LspSession>) {
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("30").stdin(Stdio::piped());
        let child = Arc::new(SharedChild::spawn(&mut cmd).unwrap());
        let session = Arc::new(dummy_session(child.clone(), child.take_stdin()));
        (child, session)
    }

    #[tokio::test]
    async fn a_stalled_write_terminates_the_process_and_releases_its_permit() {
        let (child, session) = sleeping_writer();
        let result = session
            .send_with_timeout("x".repeat(1024 * 1024), Duration::from_millis(50))
            .await;
        assert!(result.unwrap_err().contains("stalled"));
        assert!(child
            .wait_deadline(Instant::now() + Duration::from_secs(2))
            .unwrap()
            .is_some());
        let deadline = Instant::now() + Duration::from_secs(2);
        while session.writing.load(Ordering::Acquire) {
            assert!(
                Instant::now() < deadline,
                "writer kept its permit after termination"
            );
            tokio::task::yield_now().await;
        }
        assert!(session
            .kill_reason
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .contains("stalled"));
    }

    #[tokio::test]
    async fn a_concurrent_writer_is_rejected_before_waiting_for_the_pipe_lock() {
        let (child, session) = sleeping_writer();
        let first = tokio::spawn({
            let session = session.clone();
            async move { session.send("x".repeat(1024 * 1024)).await }
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while !session.writing.load(Ordering::Acquire) {
            assert!(
                Instant::now() < deadline,
                "first writer never reserved ownership"
            );
            tokio::task::yield_now().await;
        }
        assert!(session
            .send("second".into())
            .await
            .unwrap_err()
            .contains("Concurrent"));
        assert!(first.await.unwrap().is_err());
        assert!(child
            .wait_deadline(Instant::now() + Duration::from_secs(2))
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn oversized_native_messages_are_refused_before_writing() {
        let (child, session) = sleeping_writer();
        assert!(session
            .send("x".repeat(MAX_WRITE_BYTES + 1))
            .await
            .unwrap_err()
            .contains("16 MiB"));
        assert!(!session.writing.load(Ordering::Acquire));
        assert!(child
            .wait_deadline(Instant::now() + Duration::from_secs(2))
            .unwrap()
            .is_some());
    }

    #[test]
    fn write_after_kill_errors() {
        let mut cmd = Command::new("/bin/cat");
        cmd.stdin(Stdio::piped()).stdout(Stdio::null());
        let child = Arc::new(SharedChild::spawn(&mut cmd).expect("spawn"));
        let stdin = child.take_stdin();
        let session = dummy_session(child, stdin);

        session.kill();
        assert!(session.write_message("{}").is_err());
    }

    #[test]
    fn stopping_a_server_does_not_wait_for_its_blocked_stdin_writer() {
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("30").stdin(Stdio::piped());
        unsafe {
            use std::os::unix::process::CommandExt;
            cmd.pre_exec(|| {
                if libc::setpgid(0, 0) == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
        let child = Arc::new(SharedChild::spawn(&mut cmd).unwrap());
        let session = Arc::new(dummy_session(child.clone(), child.take_stdin()));
        let writer = session.clone();
        let write = thread::spawn(move || writer.write_message(&"x".repeat(1024 * 1024)));
        let deadline = Instant::now() + Duration::from_secs(2);
        while session.stdin.try_lock().is_ok() {
            assert!(Instant::now() < deadline, "writer never acquired stdin");
            thread::sleep(Duration::from_millis(1));
        }
        let stopper = session.clone();
        let (done, result) = std::sync::mpsc::channel();
        let stop = thread::spawn(move || {
            stopper.kill();
            done.send(()).unwrap();
        });
        let prompt = result.recv_timeout(Duration::from_millis(500)).is_ok();
        // Always rescue and join the reproduction before reporting a failure.
        let _ = child.kill();
        let _ = child.wait();
        stop.join().unwrap();
        assert!(write.join().unwrap().is_err());
        assert!(prompt, "Stop waited on a full language-server stdin pipe");
    }
}
