//! Explicitly unmanaged launch: no pipes, job handle, cancellation, or retained logs.
use crate::modules::workspace::{resolve_path, WorkspaceEnv};
use std::process::Stdio;

pub(super) fn spawn(
    command: String,
    cwd: Option<String>,
    workspace: WorkspaceEnv,
    enabled: bool,
) -> Result<u32, String> {
    if !enabled {
        return Err("Unmanaged launches are disabled. Enable Allow unmanaged detached commands in Settings > Agents first.".into());
    }
    if command.trim().is_empty() {
        return Err("empty command".into());
    }
    workspace.validate_supported()?;
    if let Some(dir) = &cwd {
        if !resolve_path(dir, &workspace)?.is_dir() {
            return Err("cwd is not a directory".into());
        }
    }
    let mut cmd = super::build_oneshot_command(command.trim(), &workspace, cwd.as_deref())?;
    if let (WorkspaceEnv::Local, Some(dir)) = (&workspace, &cwd) {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::modules::proc::hide_console(&mut cmd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is an async-signal-safe syscall, with no allocations or locks.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    let (send, receive) = std::sync::mpsc::channel();
    // Allocate the reaper before starting the command: failure cannot strand a child.
    std::thread::Builder::new()
        .name("oarlock-unmanaged".into())
        .stack_size(128 * 1024)
        .spawn(move || match cmd.spawn() {
            Ok(mut child) => {
                let _ = send.send(Ok(child.id()));
                let _ = child.wait();
            }
            Err(error) => {
                let _ = send.send(Err(error.to_string()));
            }
        })
        .map_err(|e| e.to_string())?;
    receive.recv().map_err(|e| e.to_string())?
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn disabled_launch_never_executes() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("ran");
        let error = spawn(
            format!("touch '{}'", marker.display()),
            None,
            WorkspaceEnv::Local,
            false,
        )
        .unwrap_err();
        assert!(error.contains("disabled"));
        assert!(!marker.exists());
    }
    #[test]
    fn explicit_unmanaged_launch_has_null_input() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("ran");
        let pid = spawn(
            format!("read value || printf done > '{}'", marker.display()),
            None,
            WorkspaceEnv::Local,
            true,
        )
        .unwrap();
        assert!(pid > 0);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !marker.exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "done");
    }
}
