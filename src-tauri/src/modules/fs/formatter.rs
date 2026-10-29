//! Format a buffer through stdin/stdout. No document write happens here: the
//! editor adopts candidate text only while its snapshot is current, then saves
//! through the native conditional transaction.
use crate::modules::{
    proc::capture::{self, Cancellation, Limits, OnTimeout},
    workspace::{resolve_path, Origin, WorkspaceEnv, WorkspaceRegistry},
};
use serde::Serialize;
use std::{
    io::{Seek, SeekFrom, Write},
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};
use tauri::Manager;

const MAX_BYTES: usize = 50 * 1024 * 1024;
#[derive(Serialize)]
pub struct Candidate {
    content: String,
    size: usize,
}

// A syntax hint for stdin only. Authorization and cwd always use the real path.
fn language_hint(path: &str, language: Option<&str>) -> Result<String, String> {
    let Some(language) = language else {
        return Ok(path.into());
    };
    if language.is_empty()
        || language.len() > 32
        || !language
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid formatter language".into());
    }
    Path::new(path)
        .with_extension(language)
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "Invalid formatter filename".into())
}

fn arguments(formatter: &str, path: &str, custom: &str) -> Result<Vec<String>, String> {
    let args: Vec<String> = match formatter {
        "biome" => vec![
            "biome".into(),
            "format".into(),
            format!("--stdin-file-path={path}"),
        ],
        "prettier" => vec!["prettier".into(), "--stdin-filepath".into(), path.into()],
        "ruff" => vec![
            "ruff".into(),
            "format".into(),
            "--stdin-filename".into(),
            path.into(),
            "-".into(),
        ],
        "rustfmt" => vec![
            "rustfmt".into(),
            "--emit".into(),
            "stdout".into(),
            "--edition".into(),
            "2021".into(),
        ],
        "gofmt" => vec!["gofmt".into()],
        "clang-format" => vec!["clang-format".into(), format!("--assume-filename={path}")],
        "shfmt" => vec!["shfmt".into(), "-filename".into(), path.into()],
        "zigfmt" => vec!["zig".into(), "fmt".into(), "--stdin".into()],
        "custom" => {
            let args: Vec<String> = serde_json::from_str(custom).map_err(|_| "Custom formatters must be a JSON argument list that reads stdin and writes stdout, such as [\"mytool\",\"--stdin\"]. In-place shell commands are unsupported.")?;
            if args.is_empty()
                || args[0].trim().is_empty()
                || args.iter().any(|arg| {
                    arg.contains("{file}")
                        || matches!(
                            arg.as_str(),
                            "--write" | "--fix" | "--in-place" | "-w" | "-i"
                        )
                })
            {
                return Err("Custom formatters must read stdin and write stdout; file placeholders and in-place flags are unsupported.".into());
            }
            args
        }
        _ => return Err("Unknown external formatter".into()),
    };
    if args.iter().any(|arg| arg.contains('\0')) {
        return Err("Invalid formatter argument".into());
    }
    Ok(args)
}

#[cfg(any(windows, test))]
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(any(windows, test))]
fn wsl_script(args: &[String], input: &Path) -> Result<String, String> {
    let input = input
        .to_str()
        .ok_or("Formatter input path is not Unicode")?;
    Ok(format!(
        "input=$(wslpath -u {}) || exit; exec {} <\"$input\"",
        quote(input),
        args.iter()
            .map(|arg| quote(arg))
            .collect::<Vec<_>>()
            .join(" ")
    ))
}

fn run(
    args: &[String],
    cwd: &str,
    content: &str,
    workspace: &WorkspaceEnv,
    timeout: Duration,
) -> Result<Candidate, String> {
    if content.len() > MAX_BYTES {
        return Err("Document exceeds the 50 MiB formatter limit".into());
    }
    let mut input = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    input
        .write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    input.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let (mut command, control) = if workspace.is_wsl() {
        let script = wsl_script(args, input.path())?;
        let (mut command, control) =
            crate::modules::shell::build_managed_command(&script, workspace, Some(cwd), false)?;
        // Formatting stdout must contain only the tool's candidate, never login-shell banners.
        command.arg("-c");
        (command, control)
    } else {
        (local_command(args, cwd)?, false)
    };
    #[cfg(not(windows))]
    let (mut command, control) = {
        if workspace.is_wsl() {
            return Err("WSL formatting is unavailable on this platform".into());
        }
        (local_command(args, cwd)?, false)
    };
    command
        .stdin(if control {
            Stdio::piped()
        } else {
            Stdio::from(input.reopen().map_err(|e| e.to_string())?)
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut command);
    let cancellation = Cancellation::default();
    let result = capture::run_cancellable(
        &mut command,
        timeout,
        Limits {
            stdout: MAX_BYTES,
            stderr: 64 * 1024,
            stop_on_stdout_cap: true,
        },
        OnTimeout::TerminateGroup,
        Some(&cancellation),
        control,
    )
    .map_err(|e| e.to_string())?;
    if result.timed_out {
        return Err("Formatter timed out; the document was not saved".into());
    }
    if result.stdout_incomplete {
        return Err(
            "Formatter output could not be read completely; the document was not saved".into(),
        );
    }
    if result.stdout_truncated {
        return Err("Formatter output exceeds 50 MiB; the document was not saved".into());
    }
    if result.exit_code != Some(0) {
        let detail = String::from_utf8_lossy(&result.stderr);
        return Err(format!(
            "Formatter failed: {}",
            detail.chars().take(500).collect::<String>()
        ));
    }
    if result.stdout.is_empty() && !content.trim().is_empty() {
        return Err("Formatter returned no candidate text; the document was not saved".into());
    }
    let size = result.stdout.len();
    let content =
        String::from_utf8(result.stdout).map_err(|_| "Formatter output is not valid UTF-8")?;
    if content.contains('\0') {
        return Err("Formatter output contains binary data".into());
    }
    Ok(Candidate { content, size })
}

fn local_command(args: &[String], cwd: &str) -> Result<Command, String> {
    let overrides = crate::modules::workspace::child_env_overrides();
    let search_path = overrides
        .iter()
        .find(|(key, _)| *key == "PATH")
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| std::env::var_os("PATH"));
    let name = Path::new(&args[0]);
    let program = if name.is_relative()
        && (args[0].contains('/') || (cfg!(windows) && args[0].contains('\\')))
    {
        Path::new(cwd).join(name)
    } else {
        name.to_path_buf()
    };
    let executable = which::which_in(program, search_path, cwd)
        .map_err(|_| format!("Formatter executable not found: {}", args[0]))?;
    let mut command = Command::new(executable);
    command.args(&args[1..]).current_dir(cwd);
    for (key, value) in overrides {
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
    Ok(command)
}

#[tauri::command]
pub async fn fs_format_document(
    app: tauri::AppHandle,
    formatter: String,
    path: String,
    content: String,
    custom_command: Option<String>,
    language: Option<String>,
    workspace: Option<WorkspaceEnv>,
) -> Result<Candidate, String> {
    super::blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let requested = resolve_path(&path, &workspace)?;
        app.state::<WorkspaceRegistry>()
            .gates(Origin::App)
            .authorized_write_target(&requested)?;
        let cwd = Path::new(&path)
            .parent()
            .and_then(Path::to_str)
            .ok_or("Document has no parent directory")?;
        app.state::<WorkspaceRegistry>()
            .gates(Origin::App)
            .spawn_cwd(Some(cwd), &workspace)?;
        let hint = language_hint(&path, language.as_deref())?;
        let args = arguments(
            &formatter,
            &hint,
            custom_command.as_deref().unwrap_or_default(),
        )?;
        run(&args, cwd, &content, &workspace, Duration::from_secs(20))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn syntax_hint_changes_only_the_extension_and_rejects_path_injection() {
        assert_eq!(
            language_hint("/repo/code.txt", Some("py")).unwrap(),
            "/repo/code.py"
        );
        assert_eq!(
            language_hint("/repo/code.txt", None).unwrap(),
            "/repo/code.txt"
        );
        for bad in [
            "",
            "../other",
            "py/other",
            "py\\other",
            "--parser=js",
            "py\0",
        ] {
            assert!(language_hint("/repo/code.txt", Some(bad)).is_err());
        }
        assert_eq!(
            arguments(
                "prettier",
                &language_hint("/repo/code.txt", Some("ts")).unwrap(),
                ""
            )
            .unwrap(),
            ["prettier", "--stdin-filepath", "/repo/code.ts"]
        );
    }

    #[test]
    fn builtins_use_stdin_flags_and_custom_commands_require_explicit_argv() {
        for formatter in [
            "biome",
            "prettier",
            "ruff",
            "rustfmt",
            "gofmt",
            "clang-format",
            "shfmt",
            "zigfmt",
        ] {
            let args = arguments(formatter, "/repo/file's.ts", "").unwrap();
            assert!(!args
                .iter()
                .any(|a| matches!(a.as_str(), "--write" | "-w" | "-i")));
        }
        assert_eq!(
            arguments("ruff", "/a.py", "").unwrap(),
            ["ruff", "format", "--stdin-filename", "/a.py", "-"]
        );
        for bad in [
            "prettier --write {file}",
            "",
            "[]",
            r#"["tool", "--write"]"#,
            r#"["tool", "{file}"]"#,
        ] {
            assert!(arguments("custom", "/a", bad).is_err());
        }
        assert_eq!(
            arguments("custom", "/a", r#"["tool", "--stdin"]"#).unwrap(),
            ["tool", "--stdin"]
        );
        assert!(arguments("unknown", "/a", "").is_err());
    }

    #[test]
    fn wsl_input_and_command_are_quoted_as_data() {
        let input = Path::new("C:/temp/it's a file");
        let script = wsl_script(&["tool".into(), "file'; echo wrong".into()], input).unwrap();
        assert!(script.starts_with("input=$(wslpath -u 'C:/temp/it'\\''s a file') || exit;"));
        assert!(script.ends_with("exec 'tool' 'file'\\''; echo wrong' <\"$input\""));
    }

    #[cfg(unix)]
    fn shell(script: &str, content: &str, timeout: Duration) -> Result<Candidate, String> {
        let dir = tempfile::tempdir().unwrap();
        run(
            &["/bin/sh".into(), "-c".into(), script.into()],
            dir.path().to_str().unwrap(),
            content,
            &WorkspaceEnv::Local,
            timeout,
        )
    }

    #[cfg(unix)]
    #[test]
    fn candidate_transport_preserves_exact_text_and_refuses_bad_results() {
        let input = "λ and quoted ' data\r\n";
        assert_eq!(
            shell("cat", input, Duration::from_secs(2)).unwrap().content,
            input
        );
        assert!(shell("printf partial; exit 2", input, Duration::from_secs(2)).is_err());
        assert!(shell("sleep 30", input, Duration::from_millis(30))
            .err()
            .unwrap()
            .contains("timed out"));
        assert!(shell("printf '\\377'", input, Duration::from_secs(2))
            .err()
            .unwrap()
            .contains("UTF-8"));
        assert!(shell("printf '\\000'", input, Duration::from_secs(2))
            .err()
            .unwrap()
            .contains("binary"));
        assert!(shell("true", input, Duration::from_secs(2))
            .err()
            .unwrap()
            .contains("no candidate"));
        assert_eq!(
            shell("cat", "", Duration::from_secs(2)).unwrap().content,
            ""
        );
        assert!(shell(
            &format!("head -c {} /dev/zero", MAX_BYTES + 1),
            input,
            Duration::from_secs(2)
        )
        .err()
        .unwrap()
        .contains("exceeds"));
    }

    #[cfg(unix)]
    #[test]
    fn a_delayed_formatter_candidate_cannot_overwrite_a_newer_document() {
        use super::super::document_save::{self, SaveError};
        use std::time::Instant;
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("document");
        let ready = temp.path().join("ready");
        let proceed = temp.path().join("proceed");
        std::fs::write(&file, b"base").unwrap();
        let expected =
            document_save::version(&std::fs::File::open(&file).unwrap(), b"base").unwrap();
        let root = temp.path().to_path_buf();
        let worker = std::thread::spawn(move || {
            run(&["/bin/sh".into(), "-c".into(), "input=$(cat); touch ready; while [ ! -f proceed ]; do sleep 0.01; done; printf 'formatted:%s' \"$input\"".into()], root.to_str().unwrap(), "base", &WorkspaceEnv::Local, Duration::from_secs(5))
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while !ready.exists() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        document_save::with_lock(&file, || {
            document_save::write_checked(&file, b"newer window edits", Some(&expected), |_| Ok(()))
        })
        .unwrap();
        std::fs::write(proceed, "go").unwrap();
        let candidate = worker.join().unwrap().unwrap();
        assert_eq!(candidate.content, "formatted:base");
        let result = document_save::with_lock(&file, || {
            document_save::write_checked(
                &file,
                candidate.content.as_bytes(),
                Some(&expected),
                |_| Ok(()),
            )
        });
        assert!(matches!(result, Err(SaveError::Conflict(_))));
        assert_eq!(std::fs::read(&file).unwrap(), b"newer window edits");
    }
}
