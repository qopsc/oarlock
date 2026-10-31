//! Bounded one-shot process runner shared by the shell tool and git.
//!
//! Costs two short-lived reader threads per call (the old runners used four)
//! and never waits on a pipe that a surviving grandchild keeps open: output is
//! collected with a grace deadline once the child is gone.

use std::io::{self, Read};
use std::process::Command;
use std::sync::{mpsc, Arc, Mutex, Weak};
use std::thread;
use std::time::Duration;

use shared_child::SharedChild;

const READER_STACK: usize = 128 * 1024;
const READ_CHUNK: usize = 16 * 1024;
/// How long output may keep arriving after a child exited normally. A
/// backgrounded grandchild (`cmd &`) inherits the pipes and would otherwise
/// pin the caller until it exits.
const EXITED_DRAIN_GRACE: Duration = Duration::from_millis(750);
const KILLED_DRAIN_GRACE: Duration = Duration::from_millis(500);
/// How long a process group may take to exit after SIGTERM before SIGKILL.
#[cfg(unix)]
pub(crate) const TERM_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone, Copy)]
pub struct Limits {
    pub stdout: usize,
    pub stderr: usize,
    /// Kill the child as soon as stdout passes its cap instead of letting it
    /// run on for output nobody will read.
    pub stop_on_stdout_cap: bool,
}

/// How a child that outlives its timeout is stopped.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum OnTimeout {
    /// Kill the child alone.
    Kill,
    /// On Unix the child leads its own process group, which gets SIGTERM and,
    /// after `TERM_GRACE`, SIGKILL: the child can clean up (git removes its
    /// lock files) and whatever it started (hooks) ends with it. Elsewhere
    /// the same as `Kill`.
    TerminateGroup,
}

#[derive(Debug, Default)]
pub struct Captured {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stdout_incomplete: bool,
    pub stderr_truncated: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

/// A shell session's lifetime. Closing it wins even while a command is spawning.
#[derive(Default)]
pub struct Cancellation {
    requested: std::sync::atomic::AtomicBool,
    state: Mutex<CancelState>,
}
#[derive(Default)]
struct CancelState {
    children: Vec<Weak<RunningChild>>,
}
impl Cancellation {
    pub fn is_requested(&self) -> bool {
        self.requested.load(std::sync::atomic::Ordering::Acquire)
    }
    /// Prevent future spawns without waiting for process teardown on the UI thread.
    pub fn request(&self) {
        self.requested
            .store(true, std::sync::atomic::Ordering::Release);
    }
    pub fn cancel(&self) {
        self.request();
        let children = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            // Keep weak references until cleanup ends. A concurrent Stop/shutdown
            // must also wait for each child's serialized stop, not return early.
            state.children.clone()
        };
        for child in children.into_iter().filter_map(|child| child.upgrade()) {
            child.stop();
        }
    }
    fn spawn(
        &self,
        cmd: &mut Command,
        how: OnTimeout,
        stdin_control: bool,
    ) -> io::Result<Arc<RunningChild>> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.requested.load(std::sync::atomic::Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "shell command cancelled",
            ));
        }
        let child = Arc::new(RunningChild::spawn(cmd, how, stdin_control, true)?);
        state.children.retain(|child| child.strong_count() > 0);
        state.children.push(Arc::downgrade(&child));
        Ok(child)
    }
}

struct RunningChild {
    child: Arc<SharedChild>,
    #[cfg(unix)]
    tree: Option<super::group::ProcessTree>,
    how: OnTimeout,
    stdin_control: bool,
    control: Mutex<Option<std::process::ChildStdin>>,
    // Serialize completion against cancellation: never signal a completed pid.
    stopped: Mutex<bool>,
    #[cfg(windows)]
    job: Mutex<Option<crate::modules::proc::job::ProcessJob>>,
}
impl RunningChild {
    fn spawn(
        cmd: &mut Command,
        how: OnTimeout,
        stdin_control: bool,
        #[cfg_attr(not(windows), allow(unused_variables))] owned: bool,
    ) -> io::Result<Self> {
        #[cfg(not(windows))]
        let child = Arc::new(SharedChild::spawn(cmd)?);
        #[cfg(windows)]
        let (child, job) = if owned && how == OnTimeout::TerminateGroup && !stdin_control {
            let (child, job) = crate::modules::proc::job::spawn_tree(cmd)?;
            (Arc::new(child), Some(job))
        } else {
            (Arc::new(SharedChild::spawn(cmd)?), None)
        };
        let control = if stdin_control {
            child.take_stdin()
        } else {
            None
        };
        Ok(Self {
            #[cfg(unix)]
            tree: (owned && how == OnTimeout::TerminateGroup && !stdin_control)
                .then(|| super::group::ProcessTree::new(child.clone())),
            child,
            how,
            stdin_control,
            control: Mutex::new(control),
            stopped: Mutex::new(false),
            #[cfg(windows)]
            job: Mutex::new(job),
        })
    }
    fn stop(&self) {
        let mut stopped = self.stopped.lock().unwrap_or_else(|e| e.into_inner());
        if *stopped {
            return;
        }
        *stopped = true;
        if self.stdin_control {
            // EOF tells the WSL supervisor to kill its Linux process group.
            drop(
                self.control
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take(),
            );
            // EOF requests termination; the supervisor's exit confirms it.
            // Keep the cancellation lock held so concurrent cleanup also waits.
            let _ = self.child.wait();
            return;
        }
        #[cfg(unix)]
        if let Some(tree) = &self.tree {
            tree.stop();
            return;
        }
        #[cfg(windows)]
        drop(self.job.lock().unwrap_or_else(|e| e.into_inner()).take());
        stop(&self.child, self.how);
    }
    fn wait(&self, timeout: Duration) -> io::Result<(Option<i32>, bool)> {
        #[cfg(unix)]
        if let Some(tree) = &self.tree {
            return tree.foreground(timeout).map(|(status, timed_out)| {
                (if timed_out { None } else { status.code() }, timed_out)
            });
        }
        match self.child.wait_timeout(timeout)? {
            Some(status) => Ok((status.code(), false)),
            None => {
                self.stop();
                let _ = self.child.wait();
                Ok((None, true))
            }
        }
    }
    fn finish(&self) {
        #[cfg(windows)]
        drop(self.job.lock().unwrap_or_else(|e| e.into_inner()).take());
        *self.stopped.lock().unwrap_or_else(|e| e.into_inner()) = true;
    }
}

impl Drop for RunningChild {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Default)]
struct Drained {
    bytes: Vec<u8>,
    truncated: bool,
    incomplete: bool,
}

struct Reader {
    shared: Arc<Mutex<Drained>>,
    done: mpsc::Receiver<()>,
}

/// Keeps reading past the cap so the child never blocks on a full pipe, unless
/// `on_cap` is given, which is called once when the cap is first exceeded.
pub type OutputObserver = Arc<dyn Fn(&[u8]) + Send + Sync>;

fn drain<R: Read>(
    mut reader: R,
    cap: usize,
    shared: &Mutex<Drained>,
    on_cap: Option<&dyn Fn()>,
    observer: Option<&OutputObserver>,
) {
    let mut buf = [0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => {
                shared.lock().unwrap_or_else(|e| e.into_inner()).incomplete = true;
                break;
            }
            Ok(n) => {
                if let Some(observer) = observer {
                    observer(&buf[..n]);
                }
                let mut out = shared.lock().unwrap_or_else(|e| e.into_inner());
                let take = cap.saturating_sub(out.bytes.len()).min(n);
                out.bytes.extend_from_slice(&buf[..take]);
                if take < n {
                    let first = !out.truncated;
                    out.truncated = true;
                    drop(out);
                    if let (true, Some(stop)) = (first, on_cap) {
                        stop();
                    }
                }
            }
        }
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    name: &'static str,
    reader: R,
    cap: usize,
    on_cap: Option<Arc<SharedChild>>,
    observer: Option<OutputObserver>,
) -> io::Result<Reader> {
    let shared = Arc::new(Mutex::new(Drained::default()));
    let (tx, done) = mpsc::channel();
    let writer = shared.clone();
    thread::Builder::new()
        .name(name.into())
        .stack_size(READER_STACK)
        .spawn(move || {
            let stop = on_cap.map(|child| {
                move || {
                    let _ = child.kill();
                }
            });
            drain(
                reader,
                cap,
                &writer,
                stop.as_ref().map(|f| f as &dyn Fn()),
                observer.as_ref(),
            );
            let _ = tx.send(());
        })?;
    Ok(Reader { shared, done })
}

/// Waits for EOF up to `grace`, then returns whatever has arrived. The reader
/// stays bounded by `cap` and exits on its own when the pipe finally closes.
fn collect(reader: &Reader, grace: Duration) -> Drained {
    let complete = reader.done.recv_timeout(grace).is_ok();
    let mut out = std::mem::take(&mut *reader.shared.lock().unwrap_or_else(|e| e.into_inner()));
    out.incomplete |= !complete;
    out
}

/// `cmd` must already pipe stdout and stderr. Blocks the calling thread, so run
/// it on the blocking pool.
pub fn run(cmd: &mut Command, timeout: Duration, limits: Limits) -> io::Result<Captured> {
    run_with(cmd, timeout, limits, OnTimeout::Kill)
}

pub fn run_with(
    cmd: &mut Command,
    timeout: Duration,
    limits: Limits,
    on_timeout: OnTimeout,
) -> io::Result<Captured> {
    run_cancellable(cmd, timeout, limits, on_timeout, None, false)
}

pub fn run_cancellable(
    cmd: &mut Command,
    timeout: Duration,
    limits: Limits,
    on_timeout: OnTimeout,
    cancellation: Option<&Cancellation>,
    stdin_control: bool,
) -> io::Result<Captured> {
    run_observed(
        cmd,
        timeout,
        limits,
        on_timeout,
        cancellation,
        stdin_control,
        None,
    )
}

pub fn run_observed(
    cmd: &mut Command,
    timeout: Duration,
    limits: Limits,
    on_timeout: OnTimeout,
    cancellation: Option<&Cancellation>,
    stdin_control: bool,
    stdout_observer: Option<OutputObserver>,
) -> io::Result<Captured> {
    #[cfg(unix)]
    if on_timeout == OnTimeout::TerminateGroup {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let running = match cancellation {
        Some(cancel) => cancel.spawn(cmd, on_timeout, stdin_control)?,
        None => Arc::new(RunningChild::spawn(cmd, on_timeout, stdin_control, false)?),
    };
    let child = running.child.clone();
    let fail = |error: io::Error| {
        running.stop();
        let _ = child.wait();
        error
    };
    let stdout = child
        .take_stdout()
        .ok_or_else(|| fail(io::Error::other("no stdout pipe")))?;
    let stderr = child
        .take_stderr()
        .ok_or_else(|| fail(io::Error::other("no stderr pipe")))?;
    let stdout_reader = spawn_reader(
        "oarlock-cap-out",
        stdout,
        limits.stdout,
        limits.stop_on_stdout_cap.then(|| child.clone()),
        stdout_observer,
    )
    .map_err(fail)?;
    let stderr_reader =
        spawn_reader("oarlock-cap-err", stderr, limits.stderr, None, None).map_err(fail)?;

    let (exit_code, timed_out) = running.wait(timeout)?;

    running.finish();
    let grace = if timed_out {
        KILLED_DRAIN_GRACE
    } else {
        EXITED_DRAIN_GRACE
    };
    let out = collect(&stdout_reader, grace);
    let err = collect(&stderr_reader, grace);
    Ok(Captured {
        stdout: out.bytes,
        stderr: err.bytes,
        stdout_truncated: out.truncated,
        stdout_incomplete: out.incomplete,
        stderr_truncated: err.truncated,
        exit_code,
        timed_out,
    })
}

fn stop(child: &SharedChild, how: OnTimeout) {
    #[cfg(unix)]
    if how == OnTimeout::TerminateGroup {
        let group = child.id() as libc::pid_t;
        // SAFETY: plain syscalls on the process group this call created. A
        // group id is not reused while any member lives, so SIGKILL after the
        // leader is reaped still reaches only what it left behind.
        unsafe { libc::killpg(group, libc::SIGTERM) };
        let exited = matches!(child.wait_timeout(TERM_GRACE), Ok(Some(_)));
        unsafe { libc::killpg(group, libc::SIGKILL) };
        if exited {
            return;
        }
    }
    #[cfg(not(unix))]
    let _ = how;
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;
    use std::time::Instant;

    fn sh(script: &str) -> Command {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }

    const LIMITS: Limits = Limits {
        stdout: 1024,
        stderr: 1024,
        stop_on_stdout_cap: false,
    };

    #[test]
    fn control_pipe_cancellation_waits_for_supervisor_exit() {
        // Emulate the interval between WSL receiving EOF and the supervisor
        // actually exiting. Stop must not release a chat/window in that gap.
        let cancel = Cancellation::default();
        let mut cmd = sh("read signal; sleep 0.2; exit 0");
        cmd.stdin(Stdio::piped());
        let child = cancel.spawn(&mut cmd, OnTimeout::Kill, true).unwrap();
        cancel.cancel();
        let exited_when_cancel_returned = child.child.try_wait().unwrap().is_some();
        child.child.wait().unwrap();
        assert!(
            exited_when_cancel_returned,
            "Stop returned with the supervisor still running"
        );
    }
    #[test]
    fn cancellation_request_rejects_spawns_before_cleanup_runs() {
        let cancel = Cancellation::default();
        cancel.request();
        let error = run_cancellable(
            &mut sh("exit 0"),
            Duration::from_secs(5),
            LIMITS,
            OnTimeout::TerminateGroup,
            Some(&cancel),
            false,
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
    }
    #[test]
    fn concurrent_cancellers_both_wait_for_process_cleanup() {
        use std::os::unix::process::CommandExt;
        let cancel = Arc::new(Cancellation::default());
        let mut cmd = sh("sleep 30");
        cmd.process_group(0);
        let child = cancel
            .spawn(&mut cmd, OnTimeout::TerminateGroup, false)
            .unwrap();
        // Hold the real cleanup lock to reproduce a close/shutdown overlap
        // deterministically; neither caller may report cancellation finished yet.
        let held = child.stopped.lock().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let first_cancel = cancel.clone();
        let first_send = send.clone();
        let first = thread::spawn(move || {
            first_cancel.cancel();
            first_send.send(()).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !cancel.requested.load(std::sync::atomic::Ordering::Acquire) {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        let second = thread::spawn(move || {
            cancel.cancel();
            send.send(()).unwrap();
        });
        assert!(receive.recv_timeout(Duration::from_millis(50)).is_err());
        drop(held);
        receive.recv_timeout(Duration::from_secs(5)).unwrap();
        receive.recv_timeout(Duration::from_secs(5)).unwrap();
        first.join().unwrap();
        second.join().unwrap();
        child.child.wait().unwrap();
    }

    #[test]
    fn cancellation_before_spawn_never_starts_the_command() {
        let cancel = Cancellation::default();
        cancel.cancel();
        let error = run_cancellable(
            &mut sh("exit 0"),
            Duration::from_secs(5),
            LIMITS,
            OnTimeout::TerminateGroup,
            Some(&cancel),
            false,
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
    }

    #[test]
    fn cancellation_stops_command_and_grandchildren() {
        let dir = tempfile::tempdir().unwrap();
        let ready = dir.path().join("ready");
        let survived = dir.path().join("survived");
        let cancel = Arc::new(Cancellation::default());
        let worker_cancel = cancel.clone();
        let script = format!(
            "(trap '' TERM; sleep 1; touch '{}') & touch '{}'; wait",
            survived.display(),
            ready.display()
        );
        let worker = thread::spawn(move || {
            run_cancellable(
                &mut sh(&script),
                Duration::from_secs(30),
                LIMITS,
                OnTimeout::TerminateGroup,
                Some(&worker_cancel),
                false,
            )
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.exists() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        cancel.cancel();
        assert!(!worker.join().unwrap().unwrap().timed_out);
        thread::sleep(Duration::from_millis(1200));
        assert!(!survived.exists(), "grandchild survived cancellation");
    }

    #[test]
    fn captures_both_streams_and_the_exit_code() {
        let out = run(
            &mut sh("printf out; printf err >&2; exit 3"),
            Duration::from_secs(5),
            LIMITS,
        )
        .unwrap();
        assert_eq!(out.stdout, b"out");
        assert_eq!(out.stderr, b"err");
        assert_eq!(out.exit_code, Some(3));
        assert!(!out.timed_out);
    }

    #[test]
    fn caps_each_stream_and_reports_truncation_without_stalling_the_child() {
        let out = run(
            &mut sh("head -c 200000 /dev/zero; head -c 5000 /dev/zero >&2"),
            Duration::from_secs(10),
            LIMITS,
        )
        .unwrap();
        assert_eq!(out.stdout.len(), 1024);
        assert!(out.stdout_truncated);
        assert_eq!(out.stderr.len(), 1024);
        assert!(out.stderr_truncated);
        assert_eq!(out.exit_code, Some(0));
    }

    #[test]
    fn a_child_can_be_stopped_the_moment_it_exceeds_the_stdout_cap() {
        let started = Instant::now();
        let out = run(
            &mut sh("yes | head -c 100000000"),
            Duration::from_secs(30),
            Limits {
                stdout: 4096,
                stderr: 1024,
                stop_on_stdout_cap: true,
            },
        )
        .unwrap();
        assert!(out.stdout_truncated);
        assert_eq!(out.stdout.len(), 4096);
        assert!(!out.timed_out);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn kills_a_child_that_outlives_the_timeout() {
        let started = Instant::now();
        let out = run(&mut sh("sleep 30"), Duration::from_millis(200), LIMITS).unwrap();
        assert!(out.timed_out);
        assert_eq!(out.exit_code, None);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_timed_out_group_gets_sigterm_first_so_it_can_clean_up() {
        let out = run_with(
            &mut sh("trap 'printf cleaned; exit 1' TERM; sleep 30 & wait"),
            Duration::from_millis(300),
            LIMITS,
            OnTimeout::TerminateGroup,
        )
        .unwrap();
        assert!(out.timed_out);
        assert_eq!(out.stdout, b"cleaned");
    }

    #[test]
    fn a_timed_out_group_takes_what_the_child_started_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("survived");
        let script = format!(
            "(trap '' TERM; sleep 1; touch '{}') & wait",
            marker.display()
        );
        let started = Instant::now();
        let out = run_with(
            &mut sh(&script),
            Duration::from_millis(200),
            LIMITS,
            OnTimeout::TerminateGroup,
        )
        .unwrap();
        assert!(out.timed_out);
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!marker.exists(), "a grandchild outlived the timeout");
    }

    #[test]
    fn a_backgrounded_grandchild_holding_the_pipes_does_not_pin_the_caller() {
        let started = Instant::now();
        let out = run(
            &mut sh("printf done; sleep 30 &"),
            Duration::from_secs(10),
            LIMITS,
        )
        .unwrap();
        assert_eq!(out.exit_code, Some(0));
        assert!(!out.timed_out);
        assert_eq!(out.stdout, b"done", "output written before exit is kept");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "returned after {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn spawn_failure_is_an_error() {
        let mut cmd = Command::new("/definitely/not/a/binary");
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        assert!(run(&mut cmd, Duration::from_secs(1), LIMITS).is_err());
    }
}

#[cfg(test)]
mod completeness_tests {
    use super::*;
    #[test]
    fn read_errors_and_missing_eof_are_not_complete_output() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("broken stream"))
            }
        }
        let shared = Mutex::new(Drained::default());
        drain(Broken, 10, &shared, None, None);
        assert!(shared.lock().unwrap().incomplete);
        let (_send, done) = mpsc::channel();
        let reader = Reader {
            shared: Arc::new(Mutex::new(Drained::default())),
            done,
        };
        assert!(collect(&reader, Duration::ZERO).incomplete);
    }
}
