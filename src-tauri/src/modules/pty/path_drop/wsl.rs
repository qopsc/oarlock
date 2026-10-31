use super::*;
use crate::modules::proc::capture::{self, Limits};
use std::time::Duration;

// The launch wrapper execs the shell with a token containing its Linux PID.
// Inherited tokens in descendants do not identify those descendants. Inspect
// only the exact matching environment entry; never return process environments.
const PROBE: &str = include_str!("wsl_probe.sh");

pub(super) fn prepare(
    session: &Session,
    distro: &str,
    shell: &str,
    token: &str,
    paths: Vec<String>,
    source: WorkspaceEnv,
) -> Result<Prepared, String> {
    if session.finished.load(std::sync::atomic::Ordering::Acquire) {
        return Err("Terminal has exited".into());
    }
    let convert = match source {
        WorkspaceEnv::Local => {
            if paths.iter().any(|p| !Path::new(p).is_absolute()) {
                return Err("Host drop paths must be absolute".into());
            }
            "host"
        }
        WorkspaceEnv::Wsl { distro: from } if from == distro => {
            if paths.iter().any(|p| !p.starts_with('/')) {
                return Err("WSL drop paths must be absolute".into());
            }
            "wsl"
        }
        _ => return Err("Cannot insert paths from another WSL distribution".into()),
    };
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args([
        "-d",
        distro,
        "--exec",
        "/usr/bin/timeout",
        "4s",
        "/bin/sh",
        "-c",
        PROBE,
        "oarlock-drop",
        token,
        shell,
        convert,
    ])
    .args(&paths);
    crate::modules::proc::hide_console(&mut cmd);
    let result = capture::run(
        &mut cmd,
        Duration::from_secs(5),
        Limits {
            stdout: 128 * 1024,
            stderr: 4096,
            stop_on_stdout_cap: true,
        },
    )
    .map_err(|e| e.to_string())?;
    if result.exit_code != Some(0)
        || result.timed_out
        || result.stdout_truncated
        || result.stdout_incomplete
    {
        return Err("Cannot verify the WSL shell or translate dropped paths. Return to the original shell prompt and retry.".into());
    }
    let output = String::from_utf8(result.stdout).map_err(|_| "Invalid WSL path encoding")?;
    let mut values = output
        .strip_suffix('\0')
        .ok_or("Incomplete WSL path conversion")?
        .split('\0');
    let dialect = values.next().and_then(dialect).ok_or("Unknown WSL shell")?;
    if !matches!(dialect, Dialect::Posix | Dialect::Fish) {
        return Err("Unsupported WSL shell".into());
    }
    let translated: Vec<String> = values.map(String::from).collect();
    if translated.len() != paths.len() || translated.iter().any(|p| !p.starts_with('/')) {
        return Err("Invalid WSL path conversion".into());
    }
    validate_paths(&translated)?;
    if !session.accepts_path_drop() {
        return Err("Terminal is closed".into());
    }
    Ok(Prepared {
        shell: dialect,
        paths: translated,
    })
}
