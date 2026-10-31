//! Native owner of custom themes: per-ID transactions, durable revisions and strict recovery.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager};
const FILE: &str = "oarlock-themes.json";
const LEGACY: &str = "oarlock-custom-themes.json";
const EVENT: &str = "oarlock://custom-themes-changed";
// Match the shared conditional writer; excessive catalogs fail without truncation.
const MAX_BYTES: u64 = 50 * 1024 * 1024;
const MAX_REVISION: u64 = 9_007_199_254_740_991;
#[derive(Default)]
pub struct ThemeState(Mutex<Option<Store>>);
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    revision: u64,
    themes: Vec<Value>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Change {
    Upsert { themes: Vec<Value> },
    /// Imports create new entries; they must not replace an existing theme.
    Create { themes: Vec<Value> },
    Delete { id: String },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedThemeFile {
    path: String,
    version: String,
}

fn with_current_theme_file<T>(
    path: &Path,
    expected: &str,
    apply: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    use super::fs::{attachment::handle_path, document_save};
    document_save::with_lock(path, || {
        let mut file = super::project_trust::open_regular(path).map_err(|e| e.to_string())?;
        if handle_path(&file)? != path {
            return Err("Theme file changed before applying it".into());
        }
        let mut bytes = Vec::new();
        (&mut file).take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("Theme file exceeds 50 MiB".into());
        }
        if document_save::version(&file, &bytes).map_err(|e| e.to_string())? != expected {
            return Err("THEME_FILE_CHANGED".into());
        }
        apply()
    })
}
fn valid_id(id: &str) -> bool {
    (2..=64).contains(&id.len())
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn object<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("Invalid theme {field}: expected an object"))
}
fn nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.trim().is_empty())
}
fn validate_theme(theme: &Value) -> Result<&str, String> {
    let fields = object(theme, "entry")?;
    let id = fields
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| valid_id(id))
        .ok_or("Invalid theme id")?;
    if !fields.get("name").is_some_and(nonempty) {
        return Err("Invalid theme name".into());
    }
    for key in ["author", "description"] {
        if fields.get(key).is_some_and(|v| !v.is_string()) {
            return Err(format!("Invalid theme {key}"));
        }
    }
    if fields.keys().any(|k| {
        !matches!(
            k.as_str(),
            "id" | "name" | "author" | "description" | "variants" | "editorTheme"
        )
    }) {
        return Err("Unknown theme field".into());
    }
    let variants = fields.get("variants").ok_or("Missing theme variants")?;
    let variants = object(variants, "variants")?;
    if variants.is_empty()
        || variants
            .keys()
            .any(|k| !matches!(k.as_str(), "light" | "dark"))
    {
        return Err("Invalid theme variants".into());
    }
    for variant in variants.values() {
        let variant = object(variant, "variant")?;
        if variant
            .keys()
            .any(|k| !matches!(k.as_str(), "colors" | "terminal"))
        {
            return Err("Unknown theme variant field".into());
        }
        if let Some(colors) = variant.get("colors") {
            for (key, value) in object(colors, "colors")? {
                if !matches!(
                    key.as_str(),
                    "background"
                        | "foreground"
                        | "card"
                        | "cardForeground"
                        | "popover"
                        | "popoverForeground"
                        | "primary"
                        | "primaryForeground"
                        | "secondary"
                        | "secondaryForeground"
                        | "muted"
                        | "mutedForeground"
                        | "accent"
                        | "accentForeground"
                        | "destructive"
                        | "border"
                        | "input"
                        | "ring"
                        | "sidebar"
                        | "sidebarForeground"
                        | "sidebarPrimary"
                        | "sidebarPrimaryForeground"
                        | "sidebarAccent"
                        | "sidebarAccentForeground"
                        | "sidebarBorder"
                        | "sidebarRing"
                        | "radius"
                ) || !nonempty(value)
                {
                    return Err(format!("Invalid theme color {key}"));
                }
            }
        }
        if let Some(terminal) = variant.get("terminal") {
            for (key, value) in object(terminal, "terminal")? {
                let valid = match key.as_str() {
                    "background" | "foreground" | "cursor" | "cursorAccent" | "selection" => {
                        value.is_string()
                    }
                    "fontFamily" => nonempty(value),
                    "fontWeight" => matches!(
                        value.as_str(),
                        Some(
                            "normal"
                                | "bold"
                                | "100"
                                | "200"
                                | "300"
                                | "400"
                                | "500"
                                | "600"
                                | "700"
                                | "800"
                                | "900"
                        )
                    ),
                    "fontSize" => value
                        .as_f64()
                        .is_some_and(|n| (8.0..=32.0).contains(&n) && n.fract() == 0.0),
                    "ansi" => value
                        .as_array()
                        .is_some_and(|v| v.len() == 16 && v.iter().all(Value::is_string)),
                    _ => false,
                };
                if !valid {
                    return Err(format!("Invalid theme terminal {key}"));
                }
            }
        }
    }
    if let Some(editor) = fields.get("editorTheme") {
        for (key, value) in object(editor, "editorTheme")? {
            if !matches!(key.as_str(), "light" | "dark") || !value.is_string() {
                return Err("Invalid editor theme".into());
            }
        }
    }
    Ok(id)
}
fn validate(snapshot: &Snapshot) -> Result<(), String> {
    if snapshot.revision > MAX_REVISION {
        return Err("Invalid theme revision".into());
    }
    let mut ids = std::collections::HashSet::new();
    for theme in &snapshot.themes {
        if !ids.insert(validate_theme(theme)?) {
            return Err("Duplicate theme id".into());
        }
    }
    Ok(())
}
fn apply(current: &Snapshot, change: Change) -> Result<Snapshot, String> {
    let mut next = current.clone();
    match change {
        Change::Create { themes } => {
            let mut ids = std::collections::HashSet::new();
            for theme in &themes {
                let id = validate_theme(theme)?;
                if !ids.insert(id) || current.themes.iter().any(|existing| existing["id"] == id) {
                    return Err("A theme with this ID already exists; retry the import".into());
                }
            }
            next.themes.extend(themes);
        }
        Change::Upsert { themes } => {
            // Validate the entire batch before changing anything. Last duplicate wins.
            for theme in &themes {
                validate_theme(theme)?;
            }
            for theme in themes {
                let id = theme["id"].as_str().expect("validated id");
                next.themes.retain(|t| t["id"] != id);
                next.themes.push(theme);
            }
        }
        Change::Delete { id } => {
            if !valid_id(&id) {
                return Err("Invalid theme id".into());
            }
            next.themes.retain(|t| t["id"] != id);
        }
    }
    if next.themes != current.themes {
        next.revision = current
            .revision
            .checked_add(1)
            .filter(|v| *v <= MAX_REVISION)
            .ok_or("Theme revision exhausted")?;
    }
    Ok(next)
}
fn read_json(path: &Path) -> Result<Option<Value>, String> {
    if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("Theme storage must be a regular file, not a symbolic link".into());
    }
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
        return Err("Themes exceed 50 MiB".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Themes exceed 50 MiB".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| e.to_string())
}
fn persist(path: &Path, snapshot: &Snapshot, expected: Option<&Snapshot>) -> Result<(), String> {
    use super::fs::document_save::{self, SaveError};
    let parent = path.parent().ok_or("Themes directory is missing")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let target = std::fs::canonicalize(parent)
        .map_err(|e| e.to_string())?
        .join(path.file_name().ok_or("Missing theme filename")?);
    let bytes = serde_json::to_vec(snapshot).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Themes exceed 50 MiB".into());
    }
    document_save::with_lock(&target, || {
        let version = if let Some(expected) = expected {
            let mut file =
                super::project_trust::open_regular(&target).map_err(|e| e.to_string())?;
            let mut previous = Vec::new();
            (&mut file)
                .take(MAX_BYTES + 1)
                .read_to_end(&mut previous)
                .map_err(|e| e.to_string())?;
            if previous.len() as u64 > MAX_BYTES {
                return Err("Themes exceed 50 MiB".into());
            }
            let disk: Snapshot = serde_json::from_slice(&previous).map_err(|e| e.to_string())?;
            if &disk != expected {
                return Err("Theme storage changed before commit; files preserved".into());
            }
            Some(document_save::version(&file, &previous).map_err(|e| e.to_string())?)
        } else {
            None
        };
        document_save::write_checked(&target, &bytes, version.as_deref(), |actual| {
            if actual == target {
                Ok(())
            } else {
                Err("Theme storage destination changed".into())
            }
        })
        .map(|_| ())
        .map_err(|e| match e {
            SaveError::Failed(message) => message,
            SaveError::Conflict(_) => "Theme storage changed during commit; files preserved".into(),
        })
    })
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
                validate(&snapshot)?;
                snapshot
            }
            None => {
                let themes = match read_json(&directory.join(LEGACY))? {
                    None => Vec::new(),
                    Some(Value::Object(mut fields)) if fields.keys().all(|k| k == "themes") => {
                        match fields.remove("themes") {
                            None => Vec::new(),
                            Some(Value::Array(themes)) => themes,
                            _ => return Err("Invalid legacy theme list".into()),
                        }
                    }
                    _ => return Err("Invalid legacy theme storage".into()),
                };
                let snapshot = Snapshot {
                    revision: 0,
                    themes,
                };
                validate(&snapshot)?;
                persist(&path, &snapshot, None)?;
                snapshot
            }
        };
        Ok(Self { path, snapshot })
    }
    fn verify_disk(&self) -> Result<(), String> {
        let disk =
            read_json(&self.path)?.ok_or("Theme storage was removed; restore it and Retry")?;
        let disk: Snapshot = serde_json::from_value(disk).map_err(|e| e.to_string())?;
        validate(&disk)?;
        if disk != self.snapshot {
            return Err("Theme storage changed outside Oarlock; restart after recovery".into());
        }
        Ok(())
    }
    fn mutate(&mut self, change: Change) -> Result<Snapshot, String> {
        let next = apply(&self.snapshot, change)?;
        if next != self.snapshot {
            self.verify_disk()?;
            persist(&self.path, &next, Some(&self.snapshot))?;
            self.snapshot = next;
        }
        Ok(self.snapshot.clone())
    }
    fn mutate_at_revision(
        &mut self,
        change: Change,
        expected_revision: Option<u64>,
    ) -> Result<Snapshot, String> {
        if let Some(revision) = expected_revision {
            self.verify_disk()?;
            if revision != self.snapshot.revision {
                return Err("THEME_REVISION_CHANGED".into());
            }
        }
        self.mutate(change)
    }
}
fn with_store<T>(
    app: &tauri::AppHandle,
    work: impl FnOnce(&mut Store) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<ThemeState>();
    let mut saved = state.0.lock().map_err(|e| e.to_string())?;
    if saved.is_none() {
        let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
        *saved=Some(Store::open(&directory).map_err(|e|format!("Custom themes could not be loaded. Files were preserved; repair them and Retry. {e}"))?);
    }
    work(saved.as_mut().expect("opened themes"))
}
#[tauri::command]
pub async fn themes_snapshot(app: tauri::AppHandle) -> Result<Snapshot, String> {
    super::fs::blocking(move || {
        with_store(&app, |store| {
            store.verify_disk()?;
            Ok(store.snapshot.clone())
        })
    })
    .await
}
#[tauri::command]
pub async fn themes_mutate(app: tauri::AppHandle, change: Change, expected_revision: Option<u64>, expected_file: Option<ExpectedThemeFile>) -> Result<Snapshot, String> {
    super::fs::blocking(move || {
        let update = || with_store(&app, |store| {
            let revision = store.snapshot.revision;
            let snapshot = store.mutate_at_revision(change, expected_revision)?;
            if snapshot.revision != revision {
                let _ = app.emit(EVENT, &snapshot);
            }
            Ok(snapshot)
        });
        if let Some(expected) = expected_file {
            use super::workspace::{Origin, WorkspaceRegistry};
            let registry = app.state::<WorkspaceRegistry>();
            let target = registry.gates(Origin::App).authorized_existing(Path::new(&expected.path))?;
            let catalog = app.path().app_data_dir().map_err(|e| e.to_string())?.join(FILE);
            if !Path::new(&expected.path).extension().is_some_and(|ext| ext.eq_ignore_ascii_case("oarlock-theme"))
                || std::fs::canonicalize(catalog).is_ok_and(|catalog| catalog == target) {
                return Err("Invalid theme source file".into());
            }
            with_current_theme_file(&target, &expected.version, update)
        } else {
            update()
        }
    })
    .await
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn stale_ingestions_cannot_publish_after_theme_or_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let revision = store.snapshot.revision;
        store.mutate(upsert("theme-new")).unwrap();
        assert!(store.mutate_at_revision(upsert("theme-old"), Some(revision)).unwrap_err().contains("THEME_REVISION_CHANGED"));
        assert!(store.snapshot.themes.iter().all(|entry| entry["id"] != "theme-old"));

        let path = dir.path().join("draft.oarlock-theme");
        std::fs::write(&path, b"old").unwrap();
        let canonical = std::fs::canonicalize(&path).unwrap();
        let file = std::fs::File::open(&canonical).unwrap();
        let version = super::super::fs::document_save::version(&file, b"old").unwrap();
        std::fs::write(&canonical, b"new").unwrap();
        let result = with_current_theme_file(&canonical, &version, || store.mutate(upsert("theme-stale")));
        assert!(result.unwrap_err().contains("THEME_FILE_CHANGED"));
        assert!(store.snapshot.themes.iter().all(|entry| entry["id"] != "theme-stale"));
    }
    fn theme(id: &str) -> Value {
        json!({"id":id,"name":id,"variants":{"dark":{"colors":{"background":"#000"}}}})
    }
    fn upsert(id: &str) -> Change {
        Change::Upsert {
            themes: vec![theme(id)],
        }
    }
    #[test]
    fn interrupted_import_cannot_overwrite_an_existing_selected_theme() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        store.mutate(upsert("selected-theme")).unwrap();
        let before = store.snapshot.clone();
        let mut replacement = theme("selected-theme");
        replacement["name"] = json!("replacement");
        assert!(store.mutate(Change::Create {
            themes: vec![theme("new-theme"), replacement],
        }).unwrap_err().contains("already exists"));
        assert_eq!(store.snapshot, before);
        assert_eq!(Store::open(dir.path()).unwrap().snapshot, before);
    }
    #[test]
    fn concurrent_independent_imports_and_deletion_do_not_lose_or_resurrect_themes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Mutex::new(Store::open(dir.path()).unwrap());
        std::thread::scope(|scope| {
            for id in ["theme-a", "theme-b"] {
                let store = &store;
                scope.spawn(move || {
                    store.lock().unwrap().mutate(upsert(id)).unwrap();
                });
            }
        });
        assert_eq!(store.lock().unwrap().snapshot.themes.len(), 2);
        std::thread::scope(|scope| {
            let s = &store;
            scope.spawn(move || {
                s.lock()
                    .unwrap()
                    .mutate(Change::Delete {
                        id: "theme-a".into(),
                    })
                    .unwrap();
            });
            let s = &store;
            scope.spawn(move || {
                s.lock().unwrap().mutate(upsert("theme-c")).unwrap();
            });
        });
        let store = store.lock().unwrap();
        assert_eq!(store.snapshot.revision, 4);
        assert!(store.snapshot.themes.iter().all(|t| t["id"] != "theme-a"));
        assert_eq!(Store::open(dir.path()).unwrap().snapshot, store.snapshot);
    }
    #[test]
    fn migration_preserves_original_and_does_not_reimport_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LEGACY);
        let bytes = serde_json::to_vec(&json!({"themes":[theme("theme-a")]})).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        assert_eq!(store.snapshot.themes, vec![theme("theme-a")]);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        store
            .mutate(Change::Delete {
                id: "theme-a".into(),
            })
            .unwrap();
        std::fs::write(&path, b"damaged old file").unwrap();
        assert!(Store::open(dir.path()).unwrap().snapshot.themes.is_empty());
    }
    #[test]
    fn damaged_files_remain_untouched_and_repair_can_retry() {
        for file in [FILE, LEGACY] {
            for bytes in [b"broken".as_slice(), b"[]", br#"{"themes":"bad"}"#] {
                let dir = tempfile::tempdir().unwrap();
                let path = dir.path().join(file);
                std::fs::write(&path, bytes).unwrap();
                assert!(Store::open(dir.path()).is_err());
                assert_eq!(std::fs::read(&path).unwrap(), bytes);
                if file == LEGACY {
                    assert!(!dir.path().join(FILE).exists());
                }
            }
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(LEGACY), b"broken").unwrap();
        assert!(Store::open(dir.path()).is_err());
        std::fs::write(dir.path().join(LEGACY), br#"{"themes":[]}"#).unwrap();
        assert!(Store::open(dir.path()).is_ok());
    }
    #[test]
    fn invalid_batch_and_failed_commit_leave_memory_and_disk_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        store.mutate(upsert("theme-a")).unwrap();
        let before = store.snapshot.clone();
        let bytes = std::fs::read(&store.path).unwrap();
        assert!(store
            .mutate(Change::Upsert {
                themes: vec![theme("theme-b"), theme("../bad")]
            })
            .is_err());
        assert_eq!(store.snapshot, before);
        assert_eq!(std::fs::read(&store.path).unwrap(), bytes);
        let mut outside = before.clone();
        outside.themes[0]["name"] = json!("external edit");
        std::fs::write(&store.path, serde_json::to_vec(&outside).unwrap()).unwrap();
        assert!(store.mutate(upsert("theme-c")).is_err());
        assert_eq!(store.snapshot, before);
        assert_eq!(Store::open(dir.path()).unwrap().snapshot, outside);
        std::fs::write(&store.path, b"damaged after load").unwrap();
        assert!(store.mutate(upsert("theme-c")).is_err());
        assert_eq!(store.snapshot, before);
        assert_eq!(std::fs::read(&store.path).unwrap(), b"damaged after load");
        std::fs::write(&store.path, &bytes).unwrap();
        store.path = dir.path().join("missing").join(FILE);
        assert!(store.mutate(upsert("theme-c")).is_err());
        assert_eq!(store.snapshot, before);
    }
    #[test]
    fn noop_deletion_and_empty_batch_do_not_advance_revision() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        assert_eq!(
            store
                .mutate(Change::Delete {
                    id: "missing".into()
                })
                .unwrap()
                .revision,
            0
        );
        assert_eq!(
            store
                .mutate(Change::Upsert { themes: vec![] })
                .unwrap()
                .revision,
            0
        );
        let mut newer = theme("theme-a");
        newer["name"] = json!("newer");
        assert_eq!(
            store
                .mutate(Change::Upsert {
                    themes: vec![theme("theme-a"), newer.clone()]
                })
                .unwrap()
                .themes,
            vec![newer]
        );
    }
    #[test]
    fn rejects_invalid_revision_duplicate_ids_and_nested_fields() {
        let mut integral = theme("theme-a");
        integral["variants"]["dark"]["terminal"] = json!({"fontSize": 8.0});
        assert!(validate_theme(&integral).is_ok());
        let mut snapshot = Snapshot {
            revision: MAX_REVISION + 1,
            themes: vec![],
        };
        assert!(validate(&snapshot).is_err());
        snapshot.revision = 0;
        snapshot.themes = vec![theme("theme-a"), theme("theme-a")];
        assert!(validate(&snapshot).is_err());
        for bad in [
            json!({"fontSize":-1}),
            json!({"fontWeight":"bolder"}),
            json!({"ansi":[]}),
            json!({"background":false}),
        ] {
            let mut entry = theme("theme-a");
            entry["variants"]["dark"]["terminal"] = bad;
            assert!(validate_theme(&entry).is_err());
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn commits_preserve_acl_and_fail_before_publishing_unsupported_metadata() {
        use super::super::fs::access_control::tests::{acl_text, add_acl};
        use std::os::fd::AsRawFd;
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        add_acl(&store.path, "group:everyone deny execute");
        let acl = acl_text(&store.path);
        store.mutate(upsert("theme-a")).unwrap();
        assert_eq!(acl_text(&store.path), acl);
        let file = std::fs::File::open(&store.path).unwrap();
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    file.as_raw_fd(),
                    c"com.oarlock.unsupported".as_ptr(),
                    b"value".as_ptr().cast(),
                    5,
                    0,
                    0,
                )
            },
            0
        );
        let before = store.snapshot.clone();
        let bytes = std::fs::read(&store.path).unwrap();
        assert!(store.mutate(upsert("theme-b")).is_err());
        assert_eq!(store.snapshot, before);
        assert_eq!(std::fs::read(&store.path).unwrap(), bytes);
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_stores_without_overwriting_the_target() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("outside");
        std::fs::write(&target, b"keep").unwrap();
        for file in [FILE, LEGACY] {
            let path = dir.path().join(file);
            symlink(&target, &path).unwrap();
            assert!(Store::open(dir.path()).is_err());
            std::fs::remove_file(path).unwrap();
        }
        assert_eq!(std::fs::read(target).unwrap(), b"keep");
    }
}

#[cfg(all(test, not(any(target_os = "macos", target_os = "linux"))))]
mod unsupported_tests {
    use super::*;
    #[test]
    fn unsupported_safe_writes_preserve_legacy_for_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join(LEGACY);
        let bytes = br#"{"themes":[]}"#;
        std::fs::write(&legacy, bytes).unwrap();
        assert!(Store::open(dir.path()).is_err());
        assert_eq!(std::fs::read(legacy).unwrap(), bytes);
        assert!(!dir.path().join(FILE).exists());
    }
}
