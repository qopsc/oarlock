//! Unix job ownership: keep the shell unreaped until its group is finished.
//! The zombie reserves its PID, so cancellation can never signal a reused group.
use shared_child::SharedChild;
use std::io;
use std::process::ExitStatus;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Phase {
    stopping: bool,
    stopped: bool,
    reaped: bool,
}
pub struct ProcessTree {
    child: Arc<SharedChild>,
    phase: Mutex<Phase>,
    changed: Condvar,
}
impl ProcessTree {
    pub fn new(child: Arc<SharedChild>) -> Self {
        Self {
            child,
            phase: Mutex::new(Phase::default()),
            changed: Condvar::new(),
        }
    }
    pub fn stop(&self) {
        let mut phase = self.phase.lock().unwrap_or_else(|e| e.into_inner());
        while phase.stopping {
            phase = self.changed.wait(phase).unwrap_or_else(|e| e.into_inner());
        }
        if phase.reaped || phase.stopped {
            return;
        }
        phase.stopping = true;
        drop(phase);
        let pid = self.child.id();
        // The wait methods cannot reap while stopping is set.
        unsafe {
            libc::killpg(pid as libc::pid_t, libc::SIGTERM);
        }
        let _ = wait_root(pid, Some(super::capture::TERM_GRACE));
        unsafe {
            libc::killpg(pid as libc::pid_t, libc::SIGKILL);
        }
        let mut phase = self.phase.lock().unwrap_or_else(|e| e.into_inner());
        phase.stopping = false;
        phase.stopped = true;
        self.changed.notify_all();
    }
    fn reap(&self) -> io::Result<ExitStatus> {
        let mut phase = self.phase.lock().unwrap_or_else(|e| e.into_inner());
        while phase.stopping {
            phase = self.changed.wait(phase).unwrap_or_else(|e| e.into_inner());
        }
        phase.reaped = true;
        self.child.wait()
    }
    pub fn foreground(&self, timeout: Duration) -> io::Result<(ExitStatus, bool)> {
        let exited = wait_root(self.child.id(), Some(timeout));
        // Even a successful shell exit cannot leave foreground descendants behind.
        self.stop();
        let status = self.reap()?;
        Ok((status, !exited?))
    }
    pub fn background(&self) -> io::Result<ExitStatus> {
        if let Err(error) = wait_root(self.child.id(), None) {
            self.stop();
            let _ = self.reap();
            return Err(error);
        }
        loop {
            let mut phase = self.phase.lock().unwrap_or_else(|e| e.into_inner());
            while phase.stopping {
                phase = self.changed.wait(phase).unwrap_or_else(|e| e.into_inner());
            }
            let alive = if phase.stopped {
                Ok(false)
            } else {
                live_members(self.child.id())
            };
            match alive {
                Ok(false) => {
                    phase.reaped = true;
                    return self.child.wait();
                }
                Ok(true) => {
                    drop(phase);
                    std::thread::sleep(Duration::from_millis(250));
                }
                Err(error) => {
                    drop(phase);
                    self.stop();
                    let _ = self.reap();
                    return Err(error);
                }
            }
        }
    }
}

fn root_exited(pid: u32) -> io::Result<bool> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOWAIT | libc::WNOHANG,
        )
    };
    if result == 0 {
        Ok(info.si_signo == libc::SIGCHLD)
    } else {
        Err(io::Error::last_os_error())
    }
}
fn wait_root(pid: u32, timeout: Option<Duration>) -> io::Result<bool> {
    let mut waiter = sigchld::Waiter::new()?;
    let deadline = timeout.map(|t| Instant::now() + t);
    loop {
        if root_exited(pid)? {
            return Ok(true);
        }
        if let Some(deadline) = deadline {
            if Instant::now() >= deadline {
                return Ok(false);
            }
            waiter.wait_deadline(deadline)?;
        } else {
            waiter.wait()?;
        }
    }
}

#[cfg(target_os = "macos")]
fn live_members(root: u32) -> io::Result<bool> {
    let mut pids = vec![0i32; 64];
    loop {
        let bytes = unsafe {
            libc::proc_listpgrppids(
                root as libc::pid_t,
                pids.as_mut_ptr().cast(),
                (pids.len() * 4) as i32,
            )
        };
        if bytes < 0 {
            return Err(io::Error::last_os_error());
        }
        let count = bytes as usize;
        if count == pids.len() {
            pids.resize(pids.len() * 2, 0);
            continue;
        }
        for pid in pids
            .into_iter()
            .take(count)
            .filter(|pid| *pid > 0 && *pid != root as i32)
        {
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let bytes = unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDTBSDINFO,
                    0,
                    (&mut info as *mut libc::proc_bsdinfo).cast(),
                    std::mem::size_of_val(&info) as i32,
                )
            };
            if bytes == std::mem::size_of_val(&info) as i32 && info.pbi_status != 5 {
                return Ok(true);
            }
        }
        return Ok(false);
    }
}
#[cfg(target_os = "linux")]
fn live_members(root: u32) -> io::Result<bool> {
    for entry in std::fs::read_dir("/proc")?.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if pid == root {
            continue;
        }
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some((_, tail)) = stat.rsplit_once(") ") else {
            continue;
        };
        let mut fields = tail.split_whitespace();
        let state = fields.next();
        fields.next();
        if fields.next().and_then(|v| v.parse::<u32>().ok()) == Some(root)
            && !matches!(state, Some("Z" | "X"))
        {
            return Ok(true);
        }
    }
    Ok(false)
}
