//! Shell identity belongs to a PTY, never to the window's current settings.
use super::Session;
use crate::modules::workspace::WorkspaceEnv;
use portable_pty::CommandBuilder;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Dialect {
    Posix,
    Fish,
    Powershell,
    Cmd,
}

fn dialect(path: &str) -> Option<Dialect> {
    let name = path.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    match name.as_str() {
        "sh" | "bash" | "zsh" | "dash" | "ksh" | "bash.exe" => Some(Dialect::Posix),
        "fish" => Some(Dialect::Fish),
        "pwsh" | "pwsh.exe" | "powershell.exe" => Some(Dialect::Powershell),
        "cmd.exe" => Some(Dialect::Cmd),
        _ => None,
    }
}

pub(super) struct Shell {
    executable: PathBuf,
    dialect: Option<Dialect>,
    #[cfg(windows)]
    wsl: Option<(String, String, String)>,
}

impl Shell {
    pub(super) fn from_command(command: &CommandBuilder) -> Self {
        let path = command
            .get_argv()
            .first()
            .map(PathBuf::from)
            .unwrap_or_default();
        let path = std::fs::canonicalize(&path).unwrap_or(path);
        // Recent macOS /bin/sh is an Apple launcher. Capture its selected
        // executable now; accepting the launcher briefly before exec creates
        // a timing-dependent false success followed by permanent rejection.
        #[cfg(target_os = "macos")]
        let path = if path == Path::new("/bin/sh") {
            std::fs::canonicalize("/private/var/select/sh").unwrap_or(path)
        } else {
            path
        };
        Self {
            dialect: path.to_str().and_then(dialect),
            executable: path,
            #[cfg(windows)]
            wsl: (|| {
                if command.get_argv().first()?.to_str()? != "wsl.exe" {
                    return None;
                }
                Some((
                    command.get_env("OARLOCK_DROP_DISTRO")?.to_str()?.into(),
                    command.get_env("OARLOCK_DROP_SHELL")?.to_str()?.into(),
                    command.get_env("OARLOCK_DROP_TOKEN")?.to_str()?.into(),
                ))
            })(),
        }
    }
}

#[derive(serde::Serialize)]
pub struct Prepared {
    shell: Dialect,
    paths: Vec<String>,
}

fn validate_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty()
        || paths.len() > 256
        || paths.iter().map(String::len).sum::<usize>() > 64 * 1024
    {
        return Err("Drop must contain 1 to 256 paths totaling at most 64 KiB".into());
    }
    if paths
        .iter()
        .any(|p| p.is_empty() || p.chars().any(char::is_control))
    {
        return Err("Cannot insert paths containing control characters".into());
    }
    Ok(())
}

fn verified_local(session: &Session) -> Result<Dialect, String> {
    if session.shell_pid == 0 || session.finished.load(std::sync::atomic::Ordering::Acquire) {
        return Err("Terminal has exited".into());
    }
    #[cfg(unix)]
    {
        let foreground = super::unpoisoned(session.master.lock())
            .as_ref()
            .and_then(|master| master.process_group_leader());
        if foreground != Some(session.shell_pid as libc::pid_t) {
            return Err("Drop requires the terminal's original shell at its prompt".into());
        }
        if !sole_group_member(session.shell_pid) {
            return Err("Another process may be reading this terminal's input".into());
        }
    }
    #[cfg(windows)]
    if super::foreground::verified_console_children(session.shell_pid) != Some(false) {
        return Err("Drop requires the terminal's original shell at its prompt".into());
    }
    let actual = process_executable(session.shell_pid).and_then(|p| std::fs::canonicalize(p).ok());
    if actual.as_ref() != Some(&session.drop_shell.executable) {
        return Err("Cannot verify the terminal's shell".into());
    }
    session
        .drop_shell
        .dialect
        .ok_or_else(|| "This shell does not support safe path drops".into())
}

pub(super) fn prepare(
    session: &Session,
    paths: Vec<String>,
    source: WorkspaceEnv,
) -> Result<Prepared, String> {
    if !session.accepts_path_drop() {
        return Err("Terminal is closed".into());
    }
    validate_paths(&paths)?;
    source.validate_supported()?;
    #[cfg(windows)]
    if let Some((distro, shell, token)) = &session.drop_shell.wsl {
        return wsl::prepare(session, distro, shell, token, paths, source);
    }
    if source.is_wsl() {
        return Err("Cannot insert WSL paths into a host shell".into());
    }
    let shell = verified_local(session)?;
    let paths = paths
        .into_iter()
        .map(|path| {
            if !Path::new(&path).is_absolute() {
                return Err("Dropped path is not absolute".into());
            }
            #[cfg(windows)]
            if shell == Dialect::Posix {
                return Ok(path.replace('\\', "/"));
            }
            Ok(path)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Prepared { shell, paths })
}

#[cfg(target_os = "macos")]
pub(super) fn process_executable(pid: u32) -> Option<PathBuf> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe { libc::proc_pidpath(pid as i32, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    use std::os::unix::ffi::OsStrExt;
    let end = buf.iter().position(|b| *b == 0)?;
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buf[..end])))
}
#[cfg(target_os = "linux")]
pub(super) fn process_executable(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}
#[cfg(windows)]
fn process_executable(pid: u32) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut buf = [0u16; 32768];
        let mut len = buf.len() as u32;
        let ok =
            QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
        CloseHandle(process);
        (ok != 0).then(|| PathBuf::from(std::ffi::OsString::from_wide(&buf[..len as usize])))
    }
}
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn process_executable(_: u32) -> Option<PathBuf> {
    None
}

#[cfg(target_os = "macos")]
fn sole_group_member(pid: u32) -> bool {
    // Two entries suffice to disprove sole ownership; a full buffer rejects.
    let mut members = [0i32; 2];
    let size = std::mem::size_of_val(&members) as i32;
    let count = unsafe { libc::proc_listpgrppids(pid as i32, members.as_mut_ptr().cast(), size) };
    count == 1 && members[0] == pid as i32
}

#[cfg(target_os = "linux")]
fn sole_group_member(pid: u32) -> bool {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    let mut found = false;
    for entry in entries {
        let Ok(entry) = entry else {
            return false;
        };
        let Some(other) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        let stat = match std::fs::read_to_string(entry.path().join("stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return false,
        };
        let group = stat
            .rsplit_once(") ")
            .and_then(|(_, rest)| rest.split_whitespace().nth(2))
            .and_then(|s| s.parse::<u32>().ok());
        if group == Some(pid) {
            if other != pid {
                return false;
            }
            found = true;
        }
    }
    found
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn sole_group_member(_: u32) -> bool {
    false
}

#[cfg(windows)]
mod wsl;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selects_dialect_from_launched_executable_not_host() {
        assert_eq!(
            dialect("C:\\Program Files\\Git\\bin\\bash.exe"),
            Some(Dialect::Posix)
        );
        assert_eq!(dialect("/usr/bin/fish"), Some(Dialect::Fish));
        assert_eq!(
            dialect("C:\\Windows\\System32\\cmd.exe"),
            Some(Dialect::Cmd)
        );
        assert_eq!(dialect("pwsh.exe"), Some(Dialect::Powershell));
        assert_eq!(dialect("ssh"), None);
        assert_eq!(dialect("nu"), None);
    }
    #[test]
    fn rejects_control_characters_and_unbounded_drops() {
        assert!(validate_paths(&["/a\nb".into()]).is_err());
        assert!(validate_paths(&[]).is_err());
        assert!(validate_paths(&vec!["/a".into(); 257]).is_err());
        assert!(validate_paths(&["/a".into()]).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_alias_does_not_choose_the_dialect() {
        let dir = tempfile::tempdir().unwrap();
        let alias = dir.path().join("fish");
        std::os::unix::fs::symlink("/bin/sh", &alias).unwrap();
        assert_eq!(
            Shell::from_command(&CommandBuilder::new(alias)).dialect,
            Some(Dialect::Posix)
        );
    }
    #[cfg(unix)]
    #[test]
    fn reads_real_process_executable() {
        assert_eq!(
            std::fs::canonicalize(process_executable(std::process::id()).unwrap()).unwrap(),
            std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap()
        );
    }
}
