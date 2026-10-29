pub mod background;
mod cwd_frame;
mod detached;
mod job_registry;
pub mod ringbuffer;
pub mod session;
mod session_registry;

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::Serialize;
use tauri::Manager;

use crate::modules::proc::capture::{self, Limits, OnTimeout};
#[cfg(windows)]
use crate::modules::workspace::validate_wsl_distro_name;
use crate::modules::workspace::{Origin, WorkspaceEnv, WorkspaceRegistry};

use background::{BackgroundLogResponse, BackgroundProc, BackgroundProcInfo};
use job_registry::JobRegistry;
use session::{SessionRunOutput, ShellSession};
use session_registry::{Owner, SessionRegistry};

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 300;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Serialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
}

/// Runs a one-shot command (`build_oneshot_command`). Output is capped and on
/// timeout the command stops with everything it started (on Unix its process
/// group gets SIGTERM, then SIGKILL). We deliberately do NOT pipe into
/// the user's interactive PTY — that would fight their input. AI tool calls
/// are presented in chat as their own structured result.
#[tauri::command]
pub async fn shell_run_command(
    app: tauri::AppHandle,
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
    workspace: Option<WorkspaceEnv>,
    origin: Option<Origin>,
) -> Result<CommandOutput, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    let workspace = WorkspaceEnv::from_option(workspace);
    let dur = clamp_timeout(timeout_secs);

    // Authorization canonicalizes the cwd and the run blocks until exit, so
    // both belong on the blocking pool, never on an async worker.
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<WorkspaceRegistry>()
            .gates(origin.unwrap_or_default())
            .spawn_cwd(cwd.as_deref(), &workspace)?;
        let cwd_path = cwd
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string);
        run_blocking(trimmed, cwd_path, workspace, dur)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn clamp_timeout(timeout_secs: Option<u64>) -> Duration {
    Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    )
}

#[cfg(test)]
pub(crate) fn run_blocking_inner(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    dur: Duration,
) -> Result<CommandOutput, String> {
    run_blocking(command, cwd, workspace, dur)
}

fn run_blocking(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    dur: Duration,
) -> Result<CommandOutput, String> {
    run_cancellable(command, cwd, workspace, dur, None, None)
}

fn run_cancellable(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    dur: Duration,
    cancellation: Option<&capture::Cancellation>,
    observer: Option<capture::OutputObserver>,
) -> Result<CommandOutput, String> {
    let (mut cmd, stdin_control) =
        build_managed_command(&command, &workspace, cwd.as_deref(), false)?;
    if let (WorkspaceEnv::Local, Some(dir)) = (&workspace, cwd) {
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

    let local_cancellation = capture::Cancellation::default();
    let captured = capture::run_observed(
        &mut cmd,
        dur,
        Limits {
            stdout: MAX_OUTPUT_BYTES,
            stderr: MAX_OUTPUT_BYTES,
            stop_on_stdout_cap: false,
        },
        OnTimeout::TerminateGroup,
        Some(cancellation.unwrap_or(&local_cancellation)),
        stdin_control,
        observer,
    )
    .map_err(|e| {
        log::warn!("shell_run_command failed: {e}");
        e.to_string()
    })?;

    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&captured.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&captured.stderr).into_owned(),
        exit_code: captured.exit_code,
        timed_out: captured.timed_out,
        truncated: captured.stdout_truncated || captured.stderr_truncated,
    })
}

// ──────────────────────────────────────────────────────────────────────────
// Persistent agent shell state + background process state.
// ──────────────────────────────────────────────────────────────────────────

pub struct ShellState {
    sessions: RwLock<SessionRegistry<Arc<ShellSession>>>,
    bg: Arc<Mutex<JobRegistry<Arc<BackgroundProc>>>>,
}

// Releases admission on spawn failure or unwinding, without retaining processes.
struct BackgroundReservation<'a> {
    registry: &'a Mutex<JobRegistry<Arc<BackgroundProc>>>,
    id: u32,
    published: bool,
}
impl Drop for BackgroundReservation<'_> {
    fn drop(&mut self) {
        if !self.published {
            self.registry
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .abandon(self.id);
        }
    }
}

impl ShellState {
    #[cfg(test)]
    fn spawn_background(
        &self,
        command: String,
        cwd: Option<String>,
        workspace: WorkspaceEnv,
        chat_id: Option<String>,
    ) -> Result<u32, String> {
        let id = self
            .bg
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reserve_for(chat_id.clone())?;
        self.spawn_background_reserved(id, command, cwd, workspace, chat_id)
    }
    fn spawn_background_reserved(
        &self,
        id: u32,
        command: String,
        cwd: Option<String>,
        workspace: WorkspaceEnv,
        chat_id: Option<String>,
    ) -> Result<u32, String> {
        let mut reservation = BackgroundReservation {
            registry: &self.bg,
            id,
            published: false,
        };
        let registry = Arc::downgrade(&self.bg);
        let proc = background::spawn_notifying(command, cwd, workspace, chat_id, move || {
            if let Some(registry) = registry.upgrade() {
                let evicted = registry
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .finish(id);
                drop(evicted); // Release log buffers outside the registry lock.
            }
        })?;
        let published = self
            .bg
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .publish(id, proc);
        match published {
            Ok(evicted) => {
                reservation.published = true;
                drop(evicted);
                Ok(id)
            }
            Err(proc) => {
                proc.kill();
                #[cfg(unix)]
                proc.finish_kill();
                Err("The app is shutting down; the background job was stopped.".into())
            }
        }
    }
    /// Stops every background process with what it started; on app exit,
    /// since nothing would read their output or stop them afterwards.
    pub fn kill_chat_background(&self, chat_id: &str) {
        let processes: Vec<_> = self
            .bg
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(_, proc)| proc.chat_id.as_deref() == Some(chat_id))
            .map(|(_, proc)| proc.clone())
            .collect();
        for proc in processes {
            proc.kill();
        }
    }

    fn finish_sessions(&self, sessions: Vec<(u32, Arc<ShellSession>)>) {
        for (_, session) in &sessions {
            session.cancellation.request();
        }
        for (id, session) in sessions {
            session.cancellation.cancel();
            self.sessions
                .write()
                .unwrap_or_else(|e| e.into_inner())
                .finish(id);
        }
    }
    pub fn stop_chat_foreground(&self, chat_id: &str) {
        let sessions = self
            .sessions
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .retire_matching(|session| session.chat_id.as_deref() == Some(chat_id));
        self.finish_sessions(sessions);
    }
    fn retire_window(&self, label: &str) -> Vec<(u32, Arc<ShellSession>)> {
        let sessions = self
            .sessions
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .release_window(label);
        for (_, session) in &sessions {
            session.cancellation.request();
        }
        sessions
    }
    pub fn release_window(&self, app: &tauri::AppHandle, label: &str) {
        let sessions = self.retire_window(label);
        if sessions.is_empty() {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<ShellState>().finish_sessions(sessions);
        });
    }

    pub fn stop_chat_background_and_wait(&self, chat_id: &str) -> Result<(), String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let (pending, processes) = {
                let registry = self.bg.lock().unwrap_or_else(|e| e.into_inner());
                (
                    registry.pending_for(chat_id),
                    registry
                        .iter()
                        .filter(|(_, p)| p.chat_id.as_deref() == Some(chat_id))
                        .map(|(_, p)| p.clone())
                        .collect::<Vec<_>>(),
                )
            };
            for proc in &processes {
                proc.kill();
            }
            if !pending && processes.iter().all(|p| p.exited.load(Ordering::Acquire)) {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err("Background jobs have not finished stopping. Retry Stop before sending another turn.".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn kill_all(&self) {
        let sessions = self
            .sessions
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .close();
        self.finish_sessions(sessions);
        let drained: Vec<Arc<BackgroundProc>> =
            self.bg.lock().unwrap_or_else(|e| e.into_inner()).close();
        for proc in &drained {
            proc.kill();
        }
        #[cfg(unix)]
        for proc in drained {
            proc.finish_kill();
        }
    }
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(SessionRegistry::default()),
            bg: Arc::new(Mutex::new(JobRegistry::default())),
        }
    }
}

#[tauri::command]
pub async fn shell_session_open(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    chat_id: Option<String>,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    origin: Option<Origin>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    // Capture the page lifetime before any disk/WSL wait. Reload invalidates it.
    let owner = app
        .state::<ShellState>()
        .sessions
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .owner(window.label())?;
    // wsl_home spawns wsl.exe on Windows and authorization hits the disk.
    let registry_app = app.clone();
    let (initial, workspace) = tauri::async_runtime::spawn_blocking(move || {
        registry_app
            .state::<WorkspaceRegistry>()
            .gates(origin.unwrap_or_default())
            .spawn_cwd(cwd.as_deref(), &workspace)?;
        let initial = match cwd.as_deref().filter(|s| !s.is_empty()) {
            Some(c) => c.to_string(),
            None => {
                if let WorkspaceEnv::Wsl { distro } = &workspace {
                    crate::modules::workspace::wsl_home(distro.clone())?
                } else {
                    crate::modules::fs::to_canon(
                        dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")),
                    )
                }
            }
        };
        Ok::<_, String>((initial, workspace))
    })
    .await
    .map_err(|e| e.to_string())??;
    super::ai_chat_control::admit(&app, chat_id.as_deref(), || {
        register_session(&app, owner, initial, workspace, chat_id.clone())
    })?
}

fn register_session(
    app: &tauri::AppHandle,
    owner: Owner,
    initial: String,
    workspace: WorkspaceEnv,
    chat_id: Option<String>,
) -> Result<u32, String> {
    let state = app.state::<ShellState>();
    let mut session = ShellSession::new(initial, workspace);
    session.chat_id = chat_id;
    let session = Arc::new(session);
    let result = state
        .sessions
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .insert(owner, session);
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn shell_session_run(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: u32,
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
    workspace: Option<WorkspaceEnv>,
    origin: Option<Origin>,
) -> Result<SessionRunOutput, String> {
    let session = app
        .state::<ShellState>()
        .sessions
        .read()
        .unwrap()
        .get_owned(window.label(), id)
        .cloned()
        .ok_or_else(|| "no shell session".to_string())?;
    let dur = clamp_timeout(timeout_secs);
    // Reject retargeting before even authorizing or starting a different distro.
    session.validate_workspace(workspace.as_ref())?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<WorkspaceRegistry>()
            .gates(origin.unwrap_or_default())
            .spawn_cwd(cwd.as_deref(), &session.workspace)?;
        session.run(command, cwd, workspace, dur)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn shell_session_close(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: u32,
) -> Result<(), String> {
    let session = app
        .state::<ShellState>()
        .sessions
        .write()
        .unwrap()
        .retire_owned(window.label(), id);
    if let Some(session) = session {
        session.cancellation.request();
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<ShellState>()
                .finish_sessions(vec![(id, session)])
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn shell_bg_spawn(
    app: tauri::AppHandle,
    command: String,
    chat_id: Option<String>,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    origin: Option<Origin>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<WorkspaceRegistry>()
            .gates(origin.unwrap_or_default())
            .spawn_cwd(cwd.as_deref(), &workspace)?;
        let state = app.state::<ShellState>();
        let id = super::ai_chat_control::admit(&app, chat_id.as_deref(), || {
            state
                .bg
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .reserve_for(chat_id.clone())
        })??;
        state.spawn_background_reserved(id, command, cwd, workspace, chat_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn shell_bg_logs(
    state: tauri::State<ShellState>,
    handle: u32,
    since_offset: Option<u64>,
) -> Result<BackgroundLogResponse, String> {
    let proc = state
        .bg
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(handle)
        .cloned()
        .ok_or_else(|| "Background job unavailable: unknown handle or finished history expired (the latest 32 finished jobs are retained).".to_string())?;
    Ok(proc.read_logs(since_offset.unwrap_or(0)))
}

#[tauri::command]
pub fn shell_bg_kill(state: tauri::State<ShellState>, handle: u32) -> Result<(), String> {
    let proc = state
        .bg
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(handle)
        .cloned();
    if let Some(proc) = proc {
        proc.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn shell_bg_kill_chat(state: tauri::State<ShellState>, chat_id: String) -> Result<(), String> {
    state.kill_chat_background(&chat_id);
    Ok(())
}

#[tauri::command]
pub fn shell_bg_list(state: tauri::State<ShellState>) -> Result<Vec<BackgroundProcInfo>, String> {
    let map = state.bg.lock().unwrap_or_else(|e| e.into_inner());
    let mut out: Vec<_> = map.iter().map(|(id, p)| p.info(id)).collect();
    out.sort_by_key(|i| i.handle);
    Ok(out)
}

// The control pipe is private to the supervisor. The user command reads /dev/null.
// Closing the pipe (Stop, timeout or app death) kills the entire Linux group,
// even if the Windows wsl.exe process would otherwise leave Linux children alive.
#[cfg(any(windows, test))]
const WSL_SUPERVISOR: &str = r#"
mode=$2
(read -r ignored; kill -KILL 0) <&0 & watcher=$!
sh "${3:--lc}" "$1" </dev/null & command=$!
wait "$command"; result=$?
# No extra processes in this scan: the supervisor reserves its group identity.
members() {
  members=
  for file in /proc/[0-9]*/stat; do
    pid=${file#/proc/}; pid=${pid%/stat}
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$watcher" ] && continue
    text=
    while IFS= read -r line; do text=$text$line; done < "$file" 2>/dev/null || continue
    fields=${text##*) }
    set -- $fields
    [ "$3" = "$$" ] || continue
    [ "$1" = Z ] && continue
    [ "$1" = X ] && continue
    members="$members $pid"
  done
}
while :; do
  members
  [ -z "$members" ] && break
  if [ "$mode" = foreground ]; then kill -KILL $members 2>/dev/null; else sleep 0.25; fi
done
kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null
exit "$result"
"#;

pub(crate) fn build_managed_command(
    command: &str,
    workspace: &WorkspaceEnv,
    cwd: Option<&str>,
    #[cfg_attr(not(windows), allow(unused_variables))] background: bool,
) -> Result<(Command, bool), String> {
    #[cfg(windows)]
    if let WorkspaceEnv::Wsl { distro } = workspace {
        validate_wsl_distro_name(distro)?;
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["-d", distro]);
        if let Some(cwd) = cwd.filter(|s| !s.is_empty()) {
            cmd.args(["--cd", cwd]);
        }
        cmd.args([
            "--exec",
            "setsid",
            "--wait",
            "sh",
            "-c",
            WSL_SUPERVISOR,
            "oarlock",
            command,
            if background {
                "background"
            } else {
                "foreground"
            },
        ]);
        return Ok((cmd, true));
    }
    Ok((build_oneshot_command(command, workspace, cwd)?, false))
}

pub(crate) fn build_oneshot_command(
    command: &str,
    #[cfg_attr(not(windows), allow(unused_variables))] workspace: &WorkspaceEnv,
    #[cfg_attr(not(windows), allow(unused_variables))] cwd: Option<&str>,
) -> Result<Command, String> {
    #[cfg(windows)]
    if let WorkspaceEnv::Wsl { distro } = workspace {
        validate_wsl_distro_name(distro)?;
        let mut cmd = Command::new("wsl.exe");
        cmd.arg("-d").arg(distro);
        if let Some(cwd) = cwd.filter(|s| !s.is_empty()) {
            cmd.arg("--cd").arg(cwd);
        }
        cmd.arg("--exec").arg("sh").arg("-lc").arg(command);
        return Ok(cmd);
    }
    #[cfg(unix)]
    {
        if workspace.is_wsl() {
            return Err(
                "WSL commands are only supported on Windows; refusing to run on the host.".into(),
            );
        }
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(command);
        for (key, value) in crate::modules::workspace::child_env_overrides() {
            match value {
                Some(v) => {
                    cmd.env(key, v);
                }
                None => {
                    cmd.env_remove(key);
                }
            }
        }
        Ok(cmd)
    }
    #[cfg(windows)]
    {
        let shell = crate::modules::pty::shell_init::windows_shell_path();
        let mut cmd = Command::new(&shell);
        let is_cmd = shell
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("cmd.exe"))
            .unwrap_or(false);
        if is_cmd {
            cmd.arg("/C").arg(command);
        } else {
            cmd.arg("-NoProfile").arg("-Command").arg(command);
        }
        Ok(cmd)
    }
}

#[tauri::command]
pub async fn shell_detached_spawn(
    app: tauri::AppHandle,
    command: String,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    origin: Option<Origin>,
) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        app.state::<WorkspaceRegistry>()
            .gates(origin.unwrap_or_default())
            .spawn_cwd(cwd.as_deref(), &workspace)?;
        let enabled = crate::modules::preferences::allow_unmanaged(&app)?;
        detached::spawn(command, cwd, workspace, enabled)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn run(cmd: &str, timeout_secs: u64) -> CommandOutput {
        run_blocking_inner(
            cmd.into(),
            None,
            WorkspaceEnv::Local,
            Duration::from_secs(timeout_secs),
        )
        .expect("run")
    }

    #[test]
    fn unsupported_wsl_environment_never_falls_back_to_a_host_shell() {
        assert!(build_oneshot_command(
            "echo should-not-run",
            &WorkspaceEnv::Wsl {
                distro: "Ubuntu".into()
            },
            None
        )
        .is_err());
    }
    #[test]
    fn closing_one_window_stops_only_its_foreground_work_in_a_shared_chat() {
        let state = ShellState::default();
        let dir = tempfile::tempdir().unwrap();
        let mut a = ShellSession::new(dir.path().to_string_lossy().into(), WorkspaceEnv::Local);
        let mut b = ShellSession::new(dir.path().to_string_lossy().into(), WorkspaceEnv::Local);
        a.chat_id = Some("shared".into());
        b.chat_id = Some("shared".into());
        let a = Arc::new(a);
        let b = Arc::new(b);
        let (first, second) = {
            let mut registry = state.sessions.write().unwrap();
            let owner_a = registry.owner("a").unwrap();
            let owner_b = registry.owner("b").unwrap();
            (
                registry.insert(owner_a, a.clone()).unwrap(),
                registry.insert(owner_b, b.clone()).unwrap(),
            )
        };
        let run_a = a.clone();
        let run_b = b.clone();
        let worker_a = std::thread::spawn(move || {
            run_a.run(
                "touch ready-a; sleep 30".into(),
                None,
                None,
                Duration::from_secs(30),
            )
        });
        let worker_b = std::thread::spawn(move || {
            run_b.run(
                "touch ready-b; sleep 30".into(),
                None,
                None,
                Duration::from_secs(30),
            )
        });
        let background = state
            .spawn_background(
                "sleep 30".into(),
                None,
                WorkspaceEnv::Local,
                Some("shared".into()),
            )
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !dir.path().join("ready-a").exists() || !dir.path().join("ready-b").exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let retired = state.retire_window("a");
        assert!(state.sessions.read().unwrap().get(&first).is_none());
        assert!(state.sessions.read().unwrap().get(&second).is_some());
        // Revocation itself rejects a command already holding an Arc, before the
        // blocking cleanup worker runs, without blocking the window event thread.
        assert!(a
            .run("touch late".into(), None, None, Duration::from_secs(1))
            .is_err());
        assert!(!dir.path().join("late").exists());
        state.finish_sessions(retired);
        assert!(!worker_a.join().unwrap().unwrap().timed_out);
        assert!(!worker_b.is_finished());
        assert!(
            !state
                .bg
                .lock()
                .unwrap()
                .get(background)
                .unwrap()
                .read_logs(0)
                .exited
        );
        state.kill_all();
        assert!(!worker_b.join().unwrap().unwrap().timed_out);
    }

    #[test]
    fn chat_stop_waits_for_a_reserved_background_start_and_its_exit() {
        let state = Arc::new(ShellState::default());
        let id = state
            .bg
            .lock()
            .unwrap()
            .reserve_for(Some("chat".into()))
            .unwrap();
        let worker = state.clone();
        let (send, receive) = std::sync::mpsc::channel();
        let stop = std::thread::spawn(move || {
            send.send(worker.stop_chat_background_and_wait("chat"))
                .unwrap();
        });
        assert!(receive.recv_timeout(Duration::from_millis(40)).is_err());
        state
            .spawn_background_reserved(
                id,
                "sleep 30".into(),
                None,
                WorkspaceEnv::Local,
                Some("chat".into()),
            )
            .unwrap();
        receive
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert!(state
            .bg
            .lock()
            .unwrap()
            .get(id)
            .unwrap()
            .exited
            .load(Ordering::Acquire));
        stop.join().unwrap();
    }
    #[test]
    fn foreground_stop_removes_only_its_chat_sessions_and_prevents_late_runs() {
        let state = ShellState::default();
        let mut a = ShellSession::new("/tmp".into(), WorkspaceEnv::Local);
        a.chat_id = Some("a".into());
        let a = Arc::new(a);
        let mut b = ShellSession::new("/tmp".into(), WorkspaceEnv::Local);
        b.chat_id = Some("b".into());
        let mut registry = state.sessions.write().unwrap();
        let owner = registry.owner("main").unwrap();
        registry.insert(owner.clone(), a.clone()).unwrap();
        registry.insert(owner, Arc::new(b)).unwrap();
        drop(registry);
        state.stop_chat_foreground("a");
        assert!(state.sessions.read().unwrap().get(&1).is_none());
        assert!(state.sessions.read().unwrap().get(&2).is_some());
        assert!(a
            .run(
                "printf should-not-run".into(),
                None,
                None,
                Duration::from_secs(1)
            )
            .err()
            .unwrap()
            .contains("cancelled"));
    }
    #[test]
    fn run_blocking_captures_stdout_and_zero_exit() {
        let out = run("printf 'hello\\n'", 5);
        assert_eq!(out.stdout, "hello\n");
        assert_eq!(out.exit_code, Some(0));
        assert!(!out.timed_out);
        assert!(!out.truncated);
    }

    #[test]
    fn run_blocking_captures_stderr_and_nonzero_exit() {
        let out = run("printf 'oops\\n' >&2; exit 3", 5);
        assert!(out.stderr.contains("oops"));
        assert_eq!(out.exit_code, Some(3));
    }

    #[test]
    fn run_blocking_times_out_long_running_command() {
        let out = run("sleep 10", 1);
        assert!(out.timed_out);
        assert_eq!(out.exit_code, None);
    }

    #[test]
    fn a_timed_out_command_takes_what_it_started_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("survived");
        let script = format!(
            "(trap '' TERM; sleep 1; touch '{}') & wait",
            marker.display()
        );
        let out = run_blocking_inner(
            script,
            None,
            WorkspaceEnv::Local,
            Duration::from_millis(200),
        )
        .expect("run");
        assert!(out.timed_out);
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!marker.exists(), "a grandchild outlived the timeout");
    }

    #[test]
    fn foreground_exit_cleans_descendants_and_preserves_status() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("survived");
        let out = run(
            &format!("(sleep 1; touch '{}') & exit 7", marker.display()),
            5,
        );
        assert_eq!(out.exit_code, Some(7));
        assert!(!out.timed_out);
        std::thread::sleep(Duration::from_millis(1200));
        assert!(!marker.exists(), "foreground descendant survived the shell");
    }

    #[test]
    fn run_blocking_truncates_huge_output() {
        let big = MAX_OUTPUT_BYTES + 4096;
        let out = run(&format!("head -c {big} /dev/zero"), 10);
        assert!(out.truncated);
        assert!(out.stdout.len() <= MAX_OUTPUT_BYTES);
    }

    #[test]
    fn failed_spawns_return_their_reserved_capacity() {
        let state = ShellState::default();
        for _ in 0..20 {
            assert!(state
                .spawn_background(" ".into(), None, WorkspaceEnv::Local, None)
                .is_err());
        }
        let mut jobs = state.bg.lock().unwrap();
        for _ in 0..16 {
            jobs.reserve().unwrap();
        }
        assert!(jobs.reserve().is_err());
    }

    #[test]
    fn real_completions_evict_history_without_polling_or_stopping_active_jobs() {
        let state = ShellState::default();
        let active = state
            .spawn_background("sleep 30".into(), None, WorkspaceEnv::Local, None)
            .unwrap();
        let mut oldest = None;
        let mut oldest_payload = None;
        for index in 0..35 {
            let id = state
                .spawn_background("printf finished".into(), None, WorkspaceEnv::Local, None)
                .unwrap();
            let proc = state.bg.lock().unwrap().get(id).unwrap().clone();
            if index == 0 {
                oldest = Some(id);
                oldest_payload = Some(Arc::downgrade(&proc));
            }
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !proc.read_logs(0).exited {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        // Querying only observes state; the completion callback must perform eviction.
        loop {
            let jobs = state.bg.lock().unwrap();
            let settled = jobs.iter().count() == 33
                && jobs.get(oldest.unwrap()).is_none()
                && oldest_payload.as_ref().unwrap().upgrade().is_none();
            assert!(!jobs.get(active).unwrap().read_logs(0).exited);
            if settled {
                break;
            }
            drop(jobs);
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        state.kill_all();
    }

    #[test]
    fn stopping_one_chats_background_jobs_leaves_others_running() {
        let state = ShellState::default();
        let first_id = state
            .spawn_background(
                "sleep 30".into(),
                None,
                WorkspaceEnv::Local,
                Some("first".into()),
            )
            .unwrap();
        let second_id = state
            .spawn_background(
                "sleep 30".into(),
                None,
                WorkspaceEnv::Local,
                Some("second".into()),
            )
            .unwrap();
        let first = state.bg.lock().unwrap().get(first_id).unwrap().clone();
        let second = state.bg.lock().unwrap().get(second_id).unwrap().clone();
        state.kill_chat_background("first");
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !first.read_logs(0).exited {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!second.read_logs(0).exited);
        state.kill_all();
    }

    #[test]
    fn app_shutdown_finishes_background_kills_before_process_exit() {
        const MARKER_ENV: &str = "OARLOCK_TEST_SHUTDOWN_MARKER";
        if let Some(marker) = std::env::var_os(MARKER_ENV) {
            let state = ShellState::default();
            let proc = background::spawn(
                format!(
                    "(trap '' TERM; sleep 1; touch '{}') & printf ready; wait",
                    std::path::Path::new(&marker).display()
                ),
                None,
                WorkspaceEnv::Local,
            )
            .unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while !proc.read_logs(0).bytes.contains("ready") {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
            let mut jobs = state.bg.lock().unwrap();
            let id = jobs.reserve().unwrap();
            assert!(jobs.publish(id, proc).is_ok());
            drop(jobs);
            state.kill_all();
            std::process::exit(0);
        }
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("survived");
        let result = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "modules::shell::tests::app_shutdown_finishes_background_kills_before_process_exit",
                "--nocapture",
            ])
            .env(MARKER_ENV, &marker)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        std::thread::sleep(Duration::from_millis(1200));
        assert!(
            !marker.exists(),
            "app exited before its kill worker stopped the descendant"
        );
    }

    #[test]
    fn wsl_supervisor_closes_the_group_when_control_pipe_closes() {
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let ready = dir.path().join("ready");
        let survived = dir.path().join("survived");
        let cancel = Arc::new(capture::Cancellation::default());
        let worker_cancel = cancel.clone();
        let command = format!(
            "(sleep 1; touch '{}') & touch '{}'; wait",
            survived.display(),
            ready.display()
        );
        let worker = std::thread::spawn(move || {
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", WSL_SUPERVISOR, "oarlock", &command])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            capture::run_cancellable(
                &mut cmd,
                Duration::from_secs(30),
                Limits {
                    stdout: 1024,
                    stderr: 1024,
                    stop_on_stdout_cap: false,
                },
                OnTimeout::TerminateGroup,
                Some(&worker_cancel),
                true,
            )
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !ready.exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        cancel.cancel();
        assert!(!worker.join().unwrap().unwrap().timed_out);
        std::thread::sleep(Duration::from_millis(1200));
        assert!(!survived.exists());
    }

    #[test]
    fn wsl_supervisor_supports_clean_shell_candidate_output() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args([
            "-c",
            WSL_SUPERVISOR,
            "oarlock",
            "printf 'candidate text'",
            "foreground",
            "-c",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let output = capture::run_cancellable(
            &mut cmd,
            Duration::from_secs(5),
            Limits {
                stdout: 1024,
                stderr: 1024,
                stop_on_stdout_cap: true,
            },
            OnTimeout::TerminateGroup,
            Some(&capture::Cancellation::default()),
            true,
        )
        .unwrap();
        assert_eq!(output.exit_code, Some(0));
        assert!(!output.timed_out);
        assert!(!output.stdout_incomplete);
        assert_eq!(output.stdout, b"candidate text");
    }

    #[test]
    fn build_oneshot_command_uses_sh_minus_c_on_unix() {
        let cmd = build_oneshot_command("echo hi", &WorkspaceEnv::Local, None).unwrap();
        assert_eq!(cmd.get_program(), "/bin/sh");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, vec!["-c", "echo hi"]);
    }
}
