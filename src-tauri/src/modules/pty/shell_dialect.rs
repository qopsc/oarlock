//! The quoting dialect of the shell a PTY launched, fixed at spawn.
use portable_pty::CommandBuilder;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    Posix,
    Fish,
    Powershell,
    Cmd,
}

pub(super) fn dialect(path: &str) -> Option<Dialect> {
    let name = path.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    match name.as_str() {
        "sh" | "bash" | "zsh" | "dash" | "ksh" | "bash.exe" => Some(Dialect::Posix),
        "fish" => Some(Dialect::Fish),
        "pwsh" | "pwsh.exe" | "powershell.exe" => Some(Dialect::Powershell),
        "cmd.exe" => Some(Dialect::Cmd),
        _ => None,
    }
}

/// Environment variable on the `wsl.exe` command that names the Linux shell. It is not in
/// `WSLENV`, so the distro never sees it.
#[cfg(any(windows, test))]
pub(super) const WSL_SHELL_VAR: &str = "OARLOCK_LAUNCH_SHELL";

pub(super) fn from_command(command: &CommandBuilder) -> Option<Dialect> {
    let argv0 = command.get_argv().first().map(PathBuf::from)?;
    let launched = std::fs::canonicalize(&argv0).unwrap_or(argv0);
    let name = launched.file_name()?.to_str()?.to_ascii_lowercase();
    if name == "wsl.exe" {
        return dialect(command.get_env("OARLOCK_LAUNCH_SHELL")?.to_str()?);
    }
    dialect(launched.to_str()?)
}

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
    fn a_wsl_launch_takes_the_dialect_of_its_linux_shell() {
        let mut cmd = CommandBuilder::new("wsl.exe");
        cmd.env(WSL_SHELL_VAR, "/usr/bin/fish");
        assert_eq!(from_command(&cmd), Some(Dialect::Fish));
        cmd.env(WSL_SHELL_VAR, "/usr/bin/nu");
        assert_eq!(from_command(&cmd), None);
        assert_eq!(from_command(&CommandBuilder::new("wsl.exe")), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_alias_does_not_choose_the_dialect() {
        let dir = tempfile::tempdir().unwrap();
        let alias = dir.path().join("fish");
        std::os::unix::fs::symlink("/bin/sh", &alias).unwrap();
        assert_eq!(
            from_command(&CommandBuilder::new(alias)),
            Some(Dialect::Posix)
        );
    }
}
