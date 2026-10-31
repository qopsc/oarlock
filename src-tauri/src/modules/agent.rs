use serde_json::{json, Value};

#[path = "agent_settings.rs"]
mod agent_settings;

// How a given agent's hook delivers our OSC 777 marker into the terminal.
#[derive(Clone, Copy)]
enum Delivery {
    // Claude returns the sequence via a `terminalSequence` JSON field (it lost
    // /dev/tty access in v2.1.139) and emits it in-band. Cross-platform.
    TerminalSequence,
    // Codex/Gemini hooks can't write to the terminal, so the hook command emits
    // the marker itself: to /dev/tty on Unix, via a CONOUT$ helper on Windows.
    Osc,
}

struct AgentSpec {
    agent: &'static str,
    dir: &'static str,
    file: &'static str,
    events: &'static [(&'static str, &'static str)],
    matcher: bool,
    delivery: Delivery,
}

const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        agent: "claude",
        dir: ".claude",
        file: "settings.json",
        events: &[
            ("UserPromptSubmit", "working"),
            ("Notification", "attention"),
            ("Stop", "finished"),
        ],
        matcher: false,
        delivery: Delivery::TerminalSequence,
    },
    AgentSpec {
        agent: "codex",
        dir: ".codex",
        file: "hooks.json",
        events: &[
            ("UserPromptSubmit", "working"),
            ("PermissionRequest", "attention"),
            ("Stop", "finished"),
        ],
        matcher: false,
        delivery: Delivery::Osc,
    },
    AgentSpec {
        agent: "gemini",
        dir: ".gemini",
        file: "settings.json",
        events: &[
            ("BeforeAgent", "working"),
            ("Notification", "attention"),
            ("AfterAgent", "finished"),
        ],
        matcher: true,
        delivery: Delivery::Osc,
    },
    // Antigravity CLI (`agy`) is built on Gemini CLI and keeps its hook
    // schema in a settings file of its own.
    AgentSpec {
        agent: "antigravity",
        dir: ".gemini/antigravity-cli",
        file: "settings.json",
        events: &[
            ("BeforeAgent", "working"),
            ("Notification", "attention"),
            ("AfterAgent", "finished"),
        ],
        matcher: true,
        delivery: Delivery::Osc,
    },
];

const PI_EXTENSION_DIR: &str = ".pi/agent/extensions";
const PI_EXTENSION_FILE: &str = "oarlock-notifications.ts";
const PI_EXTENSION_MARKER: &str = "oarlock-pi-notifications-v1";
const PI_STATUS_NEEDLES: [&str; 6] = [
    PI_EXTENSION_MARKER,
    "agent_start",
    "agent_settled",
    "notify;Oarlock;pi;${event}",
    "emit(\"working\")",
    "emit(\"finished\")",
];
const PI_EXTENSION: &str = r#"// oarlock-pi-notifications-v1
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const emit = (event: "working" | "finished") => {
    if (process.env.OARLOCK_TERMINAL) {
      process.stdout.write(`\u001b]777;notify;Oarlock;pi;${event}\u0007`);
    }
  };

  pi.on("agent_start", () => emit("working"));
  pi.on("agent_settled", () => emit("finished"));
}
"#;

// Substrings identifying a hook command as ours, across every form we've ever
// emitted (legacy /dev/tty Claude, current TerminalSequence, Osc, Windows
// helper). Used to prune our own groups before reinserting so installs are
// idempotent and migrate older markers.
const OWNED_MARKERS: [&str; 3] = ["notify;Oarlock;", "oarlock;notify", "__oarlock_notify"];

fn find(agent: &str) -> Result<&'static AgentSpec, String> {
    AGENTS
        .iter()
        .find(|s| s.agent == agent)
        .ok_or_else(|| format!("unknown agent {agent}"))
}

fn hook_command(spec: &AgentSpec, event: &str) -> String {
    match spec.delivery {
        Delivery::TerminalSequence => format!(
            r#"[ -n "$OARLOCK_TERMINAL" ] && printf '{{"terminalSequence":"\\u001b]777;notify;Oarlock;{event}\\u0007"}}' || true"#
        ),
        Delivery::Osc => osc_command(spec.agent, event),
    }
}

// Marker to the tty, then `{}` on stdout: Codex/Gemini require a JSON no-op.
#[cfg(unix)]
fn osc_command(agent: &str, event: &str) -> String {
    format!(
        r#"[ -n "$OARLOCK_TERMINAL" ] && printf '\033]777;notify;Oarlock;{agent};{event}\007' > /dev/tty; printf '{{}}'"#
    )
}

#[cfg(windows)]
fn osc_command(agent: &str, event: &str) -> String {
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "oarlock.exe".to_string());
    format!(r#""{exe}" __oarlock_notify {agent} {event}"#)
}

// The stable substring that proves a given (agent, event) hook is installed.
// Kept in sync with hook_command so status reflects what enable writes.
fn status_needle(spec: &AgentSpec, event: &str) -> String {
    match spec.delivery {
        Delivery::TerminalSequence => format!("notify;Oarlock;{event}"),
        Delivery::Osc => {
            #[cfg(unix)]
            {
                format!("notify;Oarlock;{};{event}", spec.agent)
            }
            #[cfg(windows)]
            {
                format!("__oarlock_notify {} {event}", spec.agent)
            }
        }
    }
}

// Only exact commands generated by this application (or documented legacy
// variants) are owned. A marker inside any other command is ambiguous.
fn owned_command(command: &str, spec: &AgentSpec, marker: &str) -> Result<bool, String> {
    let current = hook_command(spec, marker);
    let legacy = current
        .replace("OARLOCK_TERMINAL", "TERAX_TERMINAL")
        .replace("notify;Oarlock;", "notify;Terax;")
        .replace("__oarlock_notify", "__terax_notify");
    let old_tty = [
        r#"[ -n "$OARLOCK_TERMINAL" ] && printf '\033]777;oarlock;notify\033\\' > /dev/tty || true"#,
        r#"[ -n "$TERAX_TERMINAL" ] && printf '\033]777;terax;notify\033\\' > /dev/tty || true"#,
    ];
    if command == current || command == legacy || old_tty.contains(&command) {
        return Ok(true);
    }
    if OWNED_MARKERS.iter().any(|m| command.contains(m))
        || ["notify;Terax;", "terax;notify", "__terax_notify"]
            .iter().any(|m| command.contains(m))
    {
        return Err("Ambiguous Oarlock hook command; refusing to change agent settings".into());
    }
    Ok(false)
}

fn merge_hooks(mut root: Value, spec: &AgentSpec) -> Result<Value, String> {
    let obj = root.as_object_mut().ok_or("Agent settings must be a JSON object")?;
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or("Agent hooks must be a JSON object")?;

    for (event, marker) in spec.events {
        let arr = hooks.entry(*event).or_insert_with(|| json!([]));
        let arr = arr.as_array_mut().ok_or_else(|| format!("Agent hook event {event} must be an array"))?;
        let mut retained = Vec::with_capacity(arr.len());
        for mut group in std::mem::take(arr) {
            let object = group.as_object_mut().ok_or("Agent hook group must be an object")?;
            let entries = object.get_mut("hooks").and_then(Value::as_array_mut)
                .ok_or("Agent hook group must contain a hooks array")?;
            let mut remaining = Vec::with_capacity(entries.len());
            let mut removed = false;
            for hook in std::mem::take(entries) {
                let entry = hook.as_object().ok_or("Agent hook entry must be an object")?;
                let command = match entry.get("command") {
                    Some(Value::String(command)) => Some(command.as_str()),
                    Some(_) => return Err("Agent hook command must be a string".into()),
                    None => None,
                };
                if let Some(command) = command {
                    if owned_command(command, spec, marker)? {
                        if entry.keys().any(|key| key != "type" && key != "command") {
                            return Err("Owned hook has additional settings; refusing to remove them".into());
                        }
                        removed = true;
                        continue;
                    }
                }
                remaining.push(hook);
            }
            *entries = remaining;
            // Preserve user-authored empty groups and any nonstandard group metadata.
            let only_generated_metadata = object.keys().all(|key| key == "hooks" || key == "matcher")
                && object.get("matcher").is_none_or(|matcher| matcher == "*");
            if !(removed && entries_empty(object) && only_generated_metadata) { retained.push(group); }
        }
        *arr = retained;
        let mut group = json!({
            "hooks": [ { "type": "command", "command": hook_command(spec, marker) } ]
        });
        if spec.matcher { group["matcher"] = json!("*"); }
        arr.push(group);
    }
    Ok(root)
}

fn entries_empty(object: &serde_json::Map<String, Value>) -> bool {
    object.get("hooks").and_then(Value::as_array).is_some_and(Vec::is_empty)
}

fn existing_config(contents: Option<&str>, path: &std::path::Path) -> Result<Value, String> {
    match contents {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<Value>(s).map_err(|e| {
            format!(
                "{} is not valid JSON ({e}); refusing to overwrite",
                path.display()
            )
        }),
        _ => Ok(json!({})),
    }
}

fn home_path(dir: &str, file: &str) -> Result<std::path::PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "could not resolve home dir".to_string())?
        .join(dir)
        .join(file))
}

fn settings_path(spec: &AgentSpec) -> Result<std::path::PathBuf, String> {
    home_path(spec.dir, spec.file)
}

pub(super) fn protected_settings_paths() -> Result<Vec<std::path::PathBuf>, String> {
    let mut paths = AGENTS.iter().map(settings_path).collect::<Result<Vec<_>, _>>()?;
    paths.push(pi_extension_path()?);
    Ok(paths)
}

fn pi_extension_path() -> Result<std::path::PathBuf, String> {
    home_path(PI_EXTENSION_DIR, PI_EXTENSION_FILE)
}

fn pi_extension_contents(
    existing: Option<&str>,
    path: &std::path::Path,
) -> Result<&'static str, String> {
    if existing.is_some_and(|s| !s.trim().is_empty() && !s.contains(PI_EXTENSION_MARKER)) {
        return Err(format!(
            "{} is not managed by Oarlock; refusing to overwrite",
            path.display()
        ));
    }
    Ok(PI_EXTENSION)
}

#[cfg(test)]
fn write_atomic(path: &std::path::Path, contents: &str) -> Result<(), String> {
    // Other applications do not honor our file locks. The shared writer cannot
    // atomically compare an existing entry and replace it, so refuse that case.
    let parent = path.parent().ok_or("Agent settings have no parent directory")?;
    let parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("resolve {}: {e}", parent.display()))?;
    let target = parent.join(path.file_name().ok_or("Agent settings have no file name")?);
    super::fs::document_save::with_lock(&target, || {
        match std::fs::symlink_metadata(&target) {
            Ok(_) => return Err("Cannot safely update existing agent settings while another application may modify them. No changes were made.".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(e) => return Err(format!("inspect {}: {e}", target.display())),
        }
        super::fs::document_save::write_checked(&target, contents.as_bytes(), None, |actual| {
            if actual == target { Ok(()) } else { Err("Agent settings destination moved".into()) }
        }).map(|_| ()).map_err(|error| match error {
            super::fs::document_save::SaveError::Conflict(_) => "Agent settings appeared while installing hooks; no changes were made".into(),
            super::fs::document_save::SaveError::Failed(error) => format!("Cannot safely install agent hooks: {error}"),
        })
    })
}

fn enable_pi_extension_at(path: &std::path::Path) -> Result<(), String> {
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    agent_settings::edit(path, |existing| {
        if existing == Some(PI_EXTENSION) { return Ok(None); }
        Ok(Some(pi_extension_contents(existing, path)?.to_owned()))
    })
}

fn enable_pi_extension() -> Result<(), String> {
    enable_pi_extension_at(&pi_extension_path()?)
}

#[tauri::command]
pub async fn agent_enable_hooks(agent: String) -> Result<(), String> {
    super::fs::blocking(move || enable_hooks(&agent)).await
}

fn enable_hooks(agent: &str) -> Result<(), String> {
    if agent == "pi" {
        return enable_pi_extension();
    }
    let spec = find(agent)?;
    enable_hooks_at(&settings_path(spec)?, spec)
}

fn enable_hooks_at(path: &std::path::Path, spec: &AgentSpec) -> Result<(), String> {
    let dir = path.parent().ok_or("Agent settings have no parent directory")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    agent_settings::edit(path, |contents| {
        let existing = existing_config(contents, path)?;
        let merged = merge_hooks(existing.clone(), spec)?;
        if merged == existing { return Ok(None); }
        Ok(Some(serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?))
    })
}

// The raw OSC 777 bytes the detector parses. Kept in one place so the Windows
// CONOUT$ path can't drift from what the Unix /dev/tty hook emits.
#[cfg(any(windows, test))]
fn conout_marker(agent: &str, event: &str) -> String {
    format!("\x1b]777;notify;Oarlock;{agent};{event}\x07")
}

// Windows has no /dev/tty: the hook calls `oarlock.exe __oarlock_notify ...` and we
// write the marker into the ConPTY console. GUI-subsystem release inherits no
// console, so attach to the hook runner's first.
#[cfg(windows)]
pub fn emit_conout_marker(agent: &str, event: &str) {
    use std::io::Write;
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};

    if std::env::var_os("OARLOCK_TERMINAL").is_none() {
        return;
    }
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("CONOUT$")
    {
        let _ = f.write_all(conout_marker(agent, event).as_bytes());
    }
}

#[tauri::command]
pub async fn agent_hooks_status(agent: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || hooks_status(&agent))
        .await
        .unwrap_or(false)
}

fn hooks_status(agent: &str) -> bool {
    if agent == "pi" {
        return pi_extension_path()
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .is_some_and(|content| {
                PI_STATUS_NEEDLES
                    .iter()
                    .all(|needle| content.contains(needle))
            });
    }
    let Ok(spec) = find(agent) else {
        return false;
    };
    let Some(content) = settings_path(spec)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
    else {
        return false;
    };
    spec.events
        .iter()
        .all(|(_, m)| content.contains(&status_needle(spec, m)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(agent: &str) -> &'static AgentSpec {
        find(agent).unwrap()
    }

    fn hook_count(root: &Value, event: &str) -> usize {
        root["hooks"][event].as_array().map_or(0, Vec::len)
    }

    fn command(root: &Value, event: &str, idx: usize) -> String {
        root["hooks"][event][idx]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn claude_adds_all_event_hooks_to_empty_config() {
        let out = merge_hooks(json!({}), spec("claude")).unwrap();
        assert_eq!(hook_count(&out, "UserPromptSubmit"), 1);
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert_eq!(hook_count(&out, "Stop"), 1);
        assert!(command(&out, "Notification", 0).contains("notify;Oarlock;attention"));
        assert!(command(&out, "Stop", 0).contains("notify;Oarlock;finished"));
        assert!(command(&out, "UserPromptSubmit", 0).contains("notify;Oarlock;working"));
        assert!(command(&out, "Stop", 0).contains("terminalSequence"));
        assert!(!command(&out, "Stop", 0).contains("/dev/tty"));
    }

    #[test]
    fn is_idempotent_per_agent() {
        for agent in ["claude", "codex", "gemini", "antigravity"] {
            let s = spec(agent);
            let once = merge_hooks(json!({}), s).unwrap();
            let twice = merge_hooks(once.clone(), s).unwrap();
            assert_eq!(once, twice, "{agent} not idempotent");
        }
    }

    #[test]
    fn conout_marker_matches_detector_format() {
        // Exactly the bytes pty/agent_detect parses (ESC ] 777 ; ... BEL).
        assert_eq!(
            conout_marker("gemini", "attention"),
            "\u{1b}]777;notify;Oarlock;gemini;attention\u{7}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_emits_four_field_dev_tty_marker() {
        let out = merge_hooks(json!({}), spec("codex")).unwrap();
        assert_eq!(hook_count(&out, "UserPromptSubmit"), 1);
        assert_eq!(hook_count(&out, "PermissionRequest"), 1);
        assert_eq!(hook_count(&out, "Stop"), 1);
        let stop = command(&out, "Stop", 0);
        assert!(stop.contains("notify;Oarlock;codex;finished"));
        assert!(stop.contains("> /dev/tty"));
        // Codex Stop rejects empty/non-JSON stdout; the hook must emit a no-op.
        assert!(stop.contains("printf '{}'"));
        assert!(!stop.contains("terminalSequence"));
    }

    #[cfg(unix)]
    #[test]
    fn gemini_uses_matcher_and_named_marker() {
        let out = merge_hooks(json!({}), spec("gemini")).unwrap();
        assert_eq!(out["hooks"]["BeforeAgent"][0]["matcher"], "*");
        assert!(command(&out, "AfterAgent", 0).contains("notify;Oarlock;gemini;finished"));
        assert!(command(&out, "Notification", 0).contains("notify;Oarlock;gemini;attention"));
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_uses_gemini_hooks_with_its_own_marker() {
        let out = merge_hooks(json!({}), spec("antigravity")).unwrap();
        assert_eq!(out["hooks"]["BeforeAgent"][0]["matcher"], "*");
        for (event, marker) in [
            ("BeforeAgent", "working"),
            ("Notification", "attention"),
            ("AfterAgent", "finished"),
        ] {
            assert_eq!(hook_count(&out, event), 1, "{event}");
            let cmd = command(&out, event, 0);
            assert!(cmd.contains(&format!("notify;Oarlock;antigravity;{marker}")));
            assert!(cmd.contains("> /dev/tty"));
            assert!(cmd.contains("printf '{}'"));
        }
    }

    #[test]
    fn antigravity_settings_live_in_its_own_folder() {
        let path = settings_path(spec("antigravity")).unwrap();
        assert!(path.ends_with(".gemini/antigravity-cli/settings.json"));
        assert_ne!(path, settings_path(spec("gemini")).unwrap());
    }

    #[test]
    fn pi_extension_emits_named_working_and_finished_markers() {
        let path = std::path::Path::new("/x/oarlock-notifications.ts");
        let extension = pi_extension_contents(None, path).unwrap();
        for needle in PI_STATUS_NEEDLES {
            assert!(extension.contains(needle), "missing {needle}");
        }
        assert!(extension.contains("process.env.OARLOCK_TERMINAL"));
        assert!(extension.contains("process.stdout.write"));
    }

    #[test]
    fn pi_extension_only_replaces_oarlock_owned_file() {
        let path = std::path::Path::new("/x/oarlock-notifications.ts");
        assert!(pi_extension_contents(Some("export const mine = true;"), path).is_err());
        assert!(pi_extension_contents(Some(PI_EXTENSION), path).is_ok());
        assert!(pi_extension_contents(Some("  \n"), path).is_ok());
    }

    #[test]
    fn pi_extension_install_is_atomic_idempotent_and_preserves_foreign_files() {
        let dir = std::env::temp_dir().join(format!("oarlock-pi-extension-{}", std::process::id()));
        let path = dir.join(PI_EXTENSION_FILE);
        let _ = std::fs::remove_dir_all(&dir);

        enable_pi_extension_at(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), PI_EXTENSION);
        enable_pi_extension_at(&path).unwrap();

        std::fs::write(&path, "export const mine = true;").unwrap();
        assert!(enable_pi_extension_at(&path).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "export const mine = true;"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn pi_extension_install_preserves_symlink() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join(format!(
            "oarlock-pi-extension-symlink-{}",
            std::process::id()
        ));
        let target = dir.join("managed.ts");
        let path = dir.join(PI_EXTENSION_FILE);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&target, format!("// {PI_EXTENSION_MARKER}\n")).unwrap();
        symlink(&target, &path).unwrap();

        enable_pi_extension_at(&path).unwrap();

        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(target).unwrap(), PI_EXTENSION);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migrates_legacy_dev_tty_hook() {
        let legacy = json!({
            "hooks": {
                "Notification": [
                    { "hooks": [ {
                        "type": "command",
                        "command": "[ -n \"$OARLOCK_TERMINAL\" ] && printf '\\033]777;oarlock;notify\\033\\\\' > /dev/tty || true"
                    } ] }
                ]
            }
        });
        let out = merge_hooks(legacy, spec("claude")).unwrap();
        assert_eq!(hook_count(&out, "Notification"), 1);
        assert!(command(&out, "Notification", 0).contains("terminalSequence"));
        assert!(!command(&out, "Notification", 0).contains("/dev/tty"));
    }

    #[test]
    fn preserves_unrelated_settings_and_foreign_hooks() {
        let input = json!({
            "permissions": { "allow": ["Bash"] },
            "hooks": {
                "Notification": [
                    { "hooks": [ { "type": "command", "command": "say hi" } ] }
                ]
            }
        });
        let out = merge_hooks(input, spec("claude")).unwrap();
        assert_eq!(out["permissions"]["allow"][0], "Bash");
        assert_eq!(hook_count(&out, "Notification"), 2);
        assert_eq!(command(&out, "Notification", 0), "say hi");
    }

    #[test]
    fn rejects_non_object_root() {
        assert!(merge_hooks(json!("garbage"), spec("codex")).is_err());
    }

    #[test]
    fn prunes_empty_groups_and_collapses_duplicates() {
        let input = json!({
            "hooks": {
                "Notification": [
                    { "hooks": [] },
                    { "hooks": [ { "type": "command", "command": hook_command(spec("claude"), "attention") } ] }
                ]
            }
        });
        let out = merge_hooks(input, spec("claude")).unwrap();
        assert_eq!(hook_count(&out, "Notification"), 2);
        assert_eq!(out["hooks"]["Notification"][0]["hooks"], json!([]));
        assert!(command(&out, "Notification", 1).contains("notify;Oarlock;attention"));
    }

    #[test]
    fn existing_config_absent_or_empty_starts_fresh() {
        let p = std::path::Path::new("/x/settings.json");
        assert_eq!(existing_config(None, p).unwrap(), json!({}));
        assert_eq!(existing_config(Some("   \n"), p).unwrap(), json!({}));
    }

    #[test]
    fn existing_config_refuses_to_clobber_invalid_json() {
        let p = std::path::Path::new("/x/settings.json");
        assert!(existing_config(Some("{ not json,"), p).is_err());
        assert_eq!(
            existing_config(Some(r#"{"permissions":{}}"#), p).unwrap(),
            json!({ "permissions": {} })
        );
    }
}

#[cfg(test)]
mod preservation_tests {
    use super::*;
    #[test]
    fn mixed_group_keeps_foreign_commands_and_metadata() {
        let spec = find("claude").unwrap();
        let input = json!({"hooks":{"Notification":[{"matcher":"User", "timeout":7, "hooks":[{"type":"command","command":"echo user"},{"type":"command","command":hook_command(spec,"attention")},{"type":"command","command":"echo other"}]}]}});
        let merged = merge_hooks(input, spec).unwrap();
        assert_eq!(merged["hooks"]["Notification"][0]["matcher"], "User");
        assert_eq!(merged["hooks"]["Notification"][0]["timeout"], 7);
        assert_eq!(merged["hooks"]["Notification"][0]["hooks"], json!([{"type":"command","command":"echo user"},{"type":"command","command":"echo other"}]));
    }
    #[test]
    fn ambiguous_markers_and_unexpected_shapes_are_refused() {
        let spec = find("claude").unwrap();
        let collision = json!({"hooks":{"Notification":[{"hooks":[{"command":"echo 'notify;Oarlock; diagnostics'"}]}]}});
        assert!(merge_hooks(collision, spec).is_err());
        for input in [json!({"hooks":{"Notification":{"custom":"keep"}}}), json!({"hooks":"unexpected"}), json!([1,2]), json!({"hooks":{"Notification":[{"hooks":"bad"}]}})] {
            assert!(merge_hooks(input, spec).is_err());
        }
    }
    #[test]
    fn exact_historical_terax_hook_is_migrated() {
        let spec = find("claude").unwrap();
        let old = hook_command(spec, "attention").replace("OARLOCK_TERMINAL", "TERAX_TERMINAL").replace("notify;Oarlock;", "notify;Terax;");
        let merged = merge_hooks(json!({"hooks":{"Notification":[{"hooks":[{"command":old}]}]}}), spec).unwrap();
        assert_eq!(merged["hooks"]["Notification"].as_array().unwrap().len(), 1);
    }
}
#[cfg(test)]
#[path = "agent_regression_tests.rs"]
mod agent_regression_tests;
