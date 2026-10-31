//! One native owner for preferences, disk commits, revisions and permission gates.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager};

const FILE: &str = "oarlock-preferences.json";
const LEGACY: &str = "oarlock-settings.json";
const EVENT: &str = "oarlock://preferences-changed";
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_REVISION: u64 = 9_007_199_254_740_991;
#[derive(Default)]
pub struct PreferencesState(Mutex<Option<Store>>);
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    revision: u64,
    values: Map<String, Value>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Update {
    revision: u64,
    changes: Map<String, Value>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Change {
    Set {
        key: String,
        value: Value,
    },
    Patch {
        key: String,
        values: Map<String, Value>,
    },
}

fn strings(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}
fn string_map(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|fields| fields.values().all(Value::is_string))
}
fn validate(key: &str, value: &Value, allow_unknown: bool) -> Result<(), String> {
    let valid = match key {
        "windowVibrancy"
        | "aiAllowUnmanagedJobs"
        | "aiStopSubagents"
        | "aiStopBackgroundJobs"
        | "selectionAskAi"
        | "autostart"
        | "restoreWindowState"
        | "autocompleteEnabled"
        | "vimMode"
        | "editorWordWrap"
        | "showHidden"
        | "explorerGitDecorations"
        | "appAllFolders"
        | "aiAllFolders"
        | "terminalLinksInPreview"
        | "terminalScreenReader"
        | "terminalCursorBlink"
        | "terminalLigatures"
        | "confirmCloseRunningTerminal"
        | "macFullDiskAccessSuggested"
        | "agentNotifications"
        | "agentNotificationSound"
        | "editorAutoSave"
        | "editorFormatOnSave" => value.is_boolean(),
        "backgroundOpacity"
        | "backgroundBlur"
        | "terminalOpacity"
        | "editorFontSize"
        | "openaiCompatibleContextLimit"
        | "editorWordWrapColumn"
        | "terminalLetterSpacing"
        | "terminalLineHeight"
        | "terminalMinimumContrast"
        | "terminalFontSize"
        | "terminalScrollback"
        | "terminalPaneLimit"
        | "zoomLevel"
        | "editorAutoSaveDelay" => value.is_number(),
        "theme"
        | "themeId"
        | "backgroundKind"
        | "defaultModelId"
        | "editorTheme"
        | "customInstructions"
        | "aiApprovalMode"
        | "autocompleteTrigger"
        | "autocompleteProvider"
        | "autocompleteModelId"
        | "lmstudioBaseURL"
        | "lmstudioModelId"
        | "mlxBaseURL"
        | "mlxModelId"
        | "ollamaBaseURL"
        | "ollamaModelId"
        | "openaiCompatibleBaseURL"
        | "openaiCompatibleModelId"
        | "openrouterModelId"
        | "groqSttModel"
        | "whispercppBaseURL"
        | "diffViewMode"
        | "editorDefaultIndent"
        | "sidebarPosition"
        | "sourceControlViewMode"
        | "terminalRenderer"
        | "terminalCursorStyle"
        | "terminalFontFamily"
        | "terminalFontWeight"
        | "terminalShell"
        | "terminalFontFeatures"
        | "newTabPosition"
        | "defaultWorkspaceEnv"
        | "editorFormatter"
        | "editorCustomFormatCommand" => value.is_string(),
        "sttProvider" => matches!(value.as_str(), Some("openai" | "groq" | "whispercpp")),
        "backgroundImageId" | "lastWslDistro" => value.is_null() || value.is_string(),
        "terminalCustomShader" => value.is_null() || value.is_object(),
        "favoriteModelIds" | "recentModelIds" => value
            .as_array()
            .is_some_and(|v| v.iter().all(Value::is_string)),
        "lspCustomServers" => value.as_array().is_some_and(|servers| {
            servers.iter().all(|server| {
                server.as_object().is_some_and(|fields| {
                    ["id", "name", "command"]
                        .iter()
                        .all(|key| fields.get(*key).is_some_and(Value::is_string))
                        && fields.get("args").is_some_and(strings)
                        && fields.get("rootMarkers").is_some_and(strings)
                        && fields.get("languages").is_some_and(string_map)
                })
            })
        }),
        "shortcuts" => value.as_object().is_some_and(|fields| {
            fields.values().all(|bindings| {
                bindings.as_array().is_some_and(|bindings| {
                    bindings.iter().all(|binding| {
                        binding.as_object().is_some_and(|fields| {
                            fields.get("key").is_some_and(Value::is_string)
                                && ["ctrl", "shift", "alt", "meta"]
                                    .iter()
                                    .all(|key| fields.get(*key).is_none_or(Value::is_boolean))
                        })
                    })
                })
            })
        }),
        "terminalBehavior" => value.as_object().is_some_and(|fields| {
            fields.iter().all(|(key, value)| match key.as_str() {
                "smartCopyPaste"
                | "pasteProtection"
                | "desktopNotifications"
                | "bellSound"
                | "alternateScroll"
                | "restoreScrollback"
                | "quickTerminalAutohide" => value.is_boolean(),
                "notifyAfterSeconds" | "scrollMultiplier" | "unfocusedSplitOpacity" => {
                    value.is_number()
                }
                "optionAsAlt"
                | "copyOnSelect"
                | "clipboardRead"
                | "notifyOnCommandFinish"
                | "quickTerminalHotkey" => value.is_string(),
                _ => false,
            })
        }),
        "lspActivation" => value.as_object().is_some_and(|fields| {
            fields
                .values()
                .all(|v| matches!(v.as_str(), Some("enabled" | "dismissed")))
        }),
        "reasoningEffortByModel" | "agentLaunchCommands" | "editorFormatterByLang" => {
            string_map(value)
        }
        _ => allow_unknown,
    };
    if !valid {
        return Err(format!("Invalid preference: {key}"));
    }
    Ok(())
}
fn apply(current: &Snapshot, change: Change) -> Result<(Snapshot, Update), String> {
    let (key, value) = match change {
        Change::Set { key, value } => (key, value),
        Change::Patch { key, values } => {
            if !matches!(key.as_str(), "terminalBehavior" | "lspActivation") {
                return Err("Preference does not accept field patches".into());
            }
            let mut merged = current
                .values
                .get(&key)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for (field, value) in values {
                if key == "lspActivation" && value.is_null() {
                    merged.remove(&field);
                } else {
                    merged.insert(field, value);
                }
            }
            (key, Value::Object(merged))
        }
    };
    validate(&key, &value, false)?;
    let mut next = current.clone();
    let mut changes = Map::new();
    if current.values.get(&key) != Some(&value) {
        next.revision = current
            .revision
            .checked_add(1)
            .filter(|r| *r <= MAX_REVISION)
            .ok_or("Preference revision exhausted")?;
        next.values.insert(key.clone(), value.clone());
        changes.insert(key, value);
    }
    let update = Update {
        revision: next.revision,
        changes,
    };
    Ok((next, update))
}
fn read_json(path: &Path) -> Result<Option<Value>, String> {
    let file = match super::project_trust::open_regular(path) {
        Ok(file) => file,
        Err(e)
            if e.kind() == std::io::ErrorKind::NotFound
                && std::fs::symlink_metadata(path)
                    .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(None)
        }
        Err(e) => return Err(e.to_string()),
    };
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("Preferences exceed 64 MiB".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Preferences exceed 64 MiB".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| e.to_string())
}
fn persist(path: &Path, snapshot: &Snapshot) -> Result<(), String> {
    let parent = path.parent().ok_or("Preferences directory is missing")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, snapshot).map_err(|e| e.to_string())?;
    if file.as_file().metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("Preferences exceed 64 MiB".into());
    }
    file.flush().map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}
struct Store {
    path: PathBuf,
    snapshot: Snapshot,
}
impl Store {
    fn open(directory: &Path) -> Result<Self, String> {
        let path = directory.join(FILE);
        let snapshot = match read_json(&path)? {
            Some(value) => {
                let snapshot: Snapshot =
                    serde_json::from_value(value).map_err(|e| e.to_string())?;
                if snapshot.revision > MAX_REVISION {
                    return Err("Invalid preference revision".into());
                }
                for (key, value) in &snapshot.values {
                    validate(key, value, true)?;
                }
                snapshot
            }
            None => {
                let values = match read_json(&directory.join(LEGACY))? {
                    Some(Value::Object(values)) => values,
                    None => Map::new(),
                    _ => return Err("Invalid legacy preferences".into()),
                };
                for (key, value) in &values {
                    validate(key, value, true)?;
                }
                let snapshot = Snapshot {
                    revision: 0,
                    values,
                };
                persist(&path, &snapshot)?;
                snapshot
            }
        };
        Ok(Self { path, snapshot })
    }
    fn mutate(&mut self, change: Change) -> Result<Update, String> {
        let (next, update) = apply(&self.snapshot, change)?;
        if !update.changes.is_empty() {
            persist(&self.path, &next)?;
            self.snapshot = next;
        }
        Ok(update)
    }
    fn mutate_at_revision(&mut self, change: Change, expected: Option<u64>) -> Result<Update, String> {
        if expected.is_some_and(|revision| revision != self.snapshot.revision) {
            return Err("PREFERENCES_REVISION_CHANGED".into());
        }
        self.mutate(change)
    }
}
fn apply_access(snapshot: &Snapshot, registry: &super::workspace::WorkspaceRegistry) {
    for (key, origin) in [
        ("appAllFolders", super::workspace::Origin::App),
        ("aiAllFolders", super::workspace::Origin::Ai),
    ] {
        registry.set_all_folders(
            origin,
            snapshot.values.get(key).and_then(Value::as_bool) == Some(true),
        );
    }
}
fn with_store<T>(
    app: &tauri::AppHandle,
    work: impl FnOnce(&mut Store) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<PreferencesState>();
    let mut saved = state.0.lock().map_err(|e| e.to_string())?;
    if saved.is_none() {
        let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let store = Store::open(&directory).map_err(|e| {
            format!(
                "Preferences could not be loaded. Files were preserved; repair them and retry. {e}"
            )
        })?;
        apply_access(
            &store.snapshot,
            &app.state::<super::workspace::WorkspaceRegistry>(),
        );
        *saved = Some(store);
    }
    work(saved.as_mut().expect("opened preferences"))
}
pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    with_store(app, |_| Ok(()))
}
pub fn allow_unmanaged(app: &tauri::AppHandle) -> Result<bool, String> {
    with_store(app, |store| {
        Ok(store
            .snapshot
            .values
            .get("aiAllowUnmanagedJobs")
            .and_then(Value::as_bool)
            == Some(true))
    })
}
#[tauri::command]
pub async fn preferences_snapshot(app: tauri::AppHandle) -> Result<Snapshot, String> {
    super::fs::blocking(move || with_store(&app, |store| Ok(store.snapshot.clone()))).await
}
#[tauri::command]
pub async fn preferences_mutate(app: tauri::AppHandle, change: Change, expected_revision: Option<u64>) -> Result<Update, String> {
    super::fs::blocking(move || {
        with_store(&app, |store| {
            let update = store.mutate_at_revision(change, expected_revision)?;
            if !update.changes.is_empty() {
                apply_access(
                    &store.snapshot,
                    &app.state::<super::workspace::WorkspaceRegistry>(),
                );
                let _ = app.emit(EVENT, &update);
            }
            Ok(update)
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn set(key: &str, value: Value) -> Change {
        Change::Set {
            key: key.into(),
            value,
        }
    }
    #[test]
    fn conditional_update_rejects_a_stale_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let revision = store.snapshot.revision;
        store.mutate(set("showHidden", json!(true))).unwrap();
        assert!(store.mutate_at_revision(set("showHidden", json!(false)), Some(revision))
            .unwrap_err().contains("PREFERENCES_REVISION_CHANGED"));
        assert_eq!(store.snapshot.values["showHidden"], json!(true));
    }
    #[test]
    fn migration_preserves_legacy_and_never_reimports_it() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join(LEGACY);
        let bytes = br#"{"sttProvider":"whispercpp","aiAllFolders":false,"customEndpoints":[],"futureSetting":{"keep":true}}"#;
        std::fs::write(&legacy, bytes).unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        assert_eq!(
            store.snapshot.values["futureSetting"],
            json!({"keep": true})
        );
        assert_eq!(std::fs::read(&legacy).unwrap(), bytes);
        let first = store.mutate(set("sttProvider", json!("groq"))).unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(first.changes.len(), 1);
        std::fs::write(&legacy, b"broken legacy file").unwrap();
        assert_eq!(Store::open(dir.path()).unwrap().snapshot, store.snapshot);
        assert_eq!(
            store
                .mutate(set("sttProvider", json!("groq")))
                .unwrap()
                .revision,
            1
        );
    }
    #[test]
    fn damaged_files_are_never_replaced_by_defaults() {
        for file in [FILE, LEGACY] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(file);
            for bytes in [b"{damaged".as_slice(), b"[]"] {
                std::fs::write(&path, bytes).unwrap();
                assert!(Store::open(dir.path()).is_err());
                assert_eq!(std::fs::read(&path).unwrap(), bytes);
            }
            std::fs::File::create(&path)
                .unwrap()
                .set_len(MAX_BYTES + 1)
                .unwrap();
            assert!(Store::open(dir.path()).is_err());
        }
    }
    #[test]
    fn invalid_saved_types_are_preserved_for_recovery() {
        for (file, value) in [
            (LEGACY, json!({"aiAllFolders": "true"})),
            (
                FILE,
                json!({"revision": 2, "values": {"sttProvider": false}}),
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(file);
            let bytes = serde_json::to_vec(&value).unwrap();
            std::fs::write(&path, &bytes).unwrap();
            assert!(Store::open(dir.path()).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            if file == LEGACY {
                assert!(!dir.path().join(FILE).exists());
            }
        }
    }
    #[test]
    fn structured_preferences_reject_entries_that_crash_consumers() {
        for (key, value) in [
            ("shortcuts", json!({"open": [{"key": 42}]})),
            ("shortcuts", json!({"open": null})),
            ("shortcuts", json!({"open": [{"key": "k", "ctrl": "yes"}]})),
            ("lspCustomServers", json!([null])),
            (
                "lspCustomServers",
                json!([{"id": "a", "name": "A", "command": "server", "args": [], "languages": {"rust": "rust"}}]),
            ),
        ] {
            assert!(validate(key, &value, false).is_err());
            assert!(validate(key, &value, true).is_err());
        }
        assert!(validate(
            "shortcuts",
            &json!({"open": [{"key": "k", "meta": true}]}),
            false
        )
        .is_ok());
        assert!(validate("lspCustomServers", &json!([{"id": "a", "name": "A", "command": "server", "args": [], "languages": {"rust": "rust"}, "rootMarkers": []}]), false).is_ok());
    }
    #[test]
    fn failed_commits_preserve_revision_values_and_disk() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        store.mutate(set("aiAllFolders", json!(false))).unwrap();
        let before = store.snapshot.clone();
        let bytes = std::fs::read(&store.path).unwrap();
        for change in [
            set("aiAllFolders", json!("true")),
            set("sttProvider", json!("invalid")),
            set("unknown", json!(true)),
            Change::Patch {
                key: "aiAllFolders".into(),
                values: Map::new(),
            },
        ] {
            assert!(store.mutate(change).is_err());
        }
        let original_path = store.path.clone();
        store.path = dir.path().to_path_buf();
        assert!(store.mutate(set("aiAllFolders", json!(true))).is_err());
        assert_eq!(store.snapshot, before);
        assert_eq!(std::fs::read(original_path).unwrap(), bytes);
    }
    #[test]
    fn field_patches_merge_and_remove_lsp_choices() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let patch = |key: &str, value: Value| Change::Patch {
            key: key.into(),
            values: value.as_object().unwrap().clone(),
        };
        store
            .mutate(patch("terminalBehavior", json!({"pasteProtection": true})))
            .unwrap();
        store
            .mutate(patch("terminalBehavior", json!({"smartCopyPaste": false})))
            .unwrap();
        assert_eq!(
            store.snapshot.values["terminalBehavior"],
            json!({"pasteProtection": true, "smartCopyPaste": false})
        );
        store
            .mutate(patch("lspActivation", json!({"a": "enabled"})))
            .unwrap();
        store
            .mutate(patch("lspActivation", json!({"b": "dismissed", "a": null})))
            .unwrap();
        assert_eq!(
            store.snapshot.values["lspActivation"],
            json!({"b": "dismissed"})
        );
    }
    #[test]
    fn permission_gates_follow_committed_booleans() {
        let registry = super::super::workspace::WorkspaceRegistry::default();
        let mut snapshot = Snapshot {
            revision: 0,
            values: json!({"aiAllFolders": "true", "appAllFolders": true})
                .as_object()
                .unwrap()
                .clone(),
        };
        apply_access(&snapshot, &registry);
        assert!(!registry.set_all_folders(super::super::workspace::Origin::Ai, false));
        assert!(registry.set_all_folders(super::super::workspace::Origin::App, false));
        snapshot.values.insert("aiAllFolders".into(), json!(true));
        apply_access(&snapshot, &registry);
        snapshot.values.insert("aiAllFolders".into(), json!(false));
        apply_access(&snapshot, &registry);
        assert!(!registry.set_all_folders(super::super::workspace::Origin::Ai, false));
    }
    #[test]
    fn concurrent_saves_keep_every_edit_and_monotonic_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let store = Mutex::new(Store::open(dir.path()).unwrap());
        let keys = [
            "aiAllFolders",
            "appAllFolders",
            "vimMode",
            "editorWordWrap",
            "autocompleteEnabled",
            "selectionAskAi",
            "aiStopBackgroundJobs",
            "aiStopSubagents",
        ];
        std::thread::scope(|scope| {
            for key in keys {
                let store = &store;
                scope.spawn(move || store.lock().unwrap().mutate(set(key, json!(true))).unwrap());
            }
        });
        let store = store.into_inner().unwrap();
        assert_eq!(store.snapshot.revision, keys.len() as u64);
        for key in keys {
            assert_eq!(store.snapshot.values[key], json!(true));
        }
        assert_eq!(Store::open(dir.path()).unwrap().snapshot, store.snapshot);
    }
}
