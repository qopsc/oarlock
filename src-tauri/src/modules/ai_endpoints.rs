//! Native-owned endpoint metadata and credential coordination. Metadata patches,
//! credential writes and deletion share one gate; credentials stay in the keychain.
//! The general settings plugin never opens or rewrites the endpoint metadata file.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

const FILE: &str = "oarlock-endpoints.json";
const EVENT: &str = "oarlock://endpoints-changed";
const MAX_BYTES: u64 = 64 * 1024 * 1024;
#[derive(Default)]
pub struct EndpointState(Mutex<Option<Store>>);
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Endpoint {
    id: String,
    name: String,
    #[serde(rename = "baseURL")]
    base_url: String,
    model_id: String,
    context_limit: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    revision: u64,
    endpoints: Vec<Endpoint>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Change {
    Create {
        endpoint: Map<String, Value>,
    },
    Update {
        id: String,
        patch: Map<String, Value>,
    },
    Delete {
        id: String,
    },
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn validate(endpoint: &Endpoint) -> Result<(), String> {
    if !valid_id(&endpoint.id)
        || endpoint.name.len() > 1024
        || endpoint.base_url.len() > 8192
        || endpoint.model_id.len() > 8192
        || !(1000..=u32::MAX as u64).contains(&endpoint.context_limit)
        || [&endpoint.name, &endpoint.base_url, &endpoint.model_id]
            .into_iter()
            .any(|v| v.contains('\0'))
    {
        return Err("invalid custom endpoint".into());
    }
    Ok(())
}
fn validate_snapshot(snapshot: &Snapshot) -> Result<(), String> {
    if snapshot.revision > 9_007_199_254_740_991 {
        return Err("invalid endpoint revision".into());
    }
    let mut ids = std::collections::HashSet::new();
    for endpoint in &snapshot.endpoints {
        validate(endpoint)?;
        if !ids.insert(&endpoint.id) {
            return Err("duplicate endpoint identity".into());
        }
    }
    Ok(())
}
/// The generated ID is supplied by the native boundary, never by the page.
fn apply(current: &Snapshot, change: Change, new_id: &str) -> Result<Snapshot, String> {
    let mut next = current.clone();
    match change {
        Change::Create { mut endpoint } => {
            if endpoint.contains_key("id") {
                return Err("endpoint identities are assigned by Oarlock".into());
            }
            endpoint.insert("id".into(), Value::String(new_id.into()));
            let endpoint: Endpoint =
                serde_json::from_value(Value::Object(endpoint)).map_err(|e| e.to_string())?;
            validate(&endpoint)?;
            if next.endpoints.iter().any(|e| e.id == endpoint.id) {
                return Err("endpoint identity already exists".into());
            }
            next.endpoints.push(endpoint);
        }
        Change::Update { id, patch } => {
            if patch
                .keys()
                .any(|k| !matches!(k.as_str(), "name" | "baseURL" | "modelId" | "contextLimit"))
            {
                return Err("invalid endpoint field".into());
            }
            let endpoint = next
                .endpoints
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or("endpoint was removed; reopen Settings")?;
            let mut value = serde_json::to_value(&*endpoint).map_err(|e| e.to_string())?;
            value
                .as_object_mut()
                .expect("endpoint object")
                .extend(patch);
            *endpoint = serde_json::from_value(value).map_err(|e| e.to_string())?;
            validate(endpoint)?;
        }
        Change::Delete { id } => {
            if !valid_id(&id) {
                return Err("invalid endpoint identity".into());
            }
            next.endpoints.retain(|e| e.id != id);
        }
    }
    if next.endpoints != current.endpoints {
        next.revision = current
            .revision
            .checked_add(1)
            .filter(|r| *r <= 9_007_199_254_740_991)
            .ok_or("endpoint revision exhausted")?;
    }
    Ok(next)
}
fn read_json(path: &Path) -> Result<Option<Value>, String> {
    let file = match std::fs::File::open(path) {
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
        return Err("endpoint source exceeds 64 MiB".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("endpoint source exceeds 64 MiB".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| e.to_string())
}
fn migrate(value: Option<Value>) -> Result<Snapshot, String> {
    let value = value.unwrap_or(Value::Object(Map::new()));
    let object = value.as_object().ok_or("invalid legacy settings")?;
    let endpoints = if let Some(value) = object.get("customEndpoints") {
        serde_json::from_value(value.clone()).map_err(|e| e.to_string())?
    } else {
        let base_url = object
            .get("openaiCompatibleBaseURL")
            .and_then(Value::as_str)
            .unwrap_or("");
        let model_id = object
            .get("openaiCompatibleModelId")
            .and_then(Value::as_str)
            .unwrap_or("");
        if base_url.trim().is_empty() || model_id.trim().is_empty() {
            vec![]
        } else {
            vec![Endpoint {
                id: "legacy".into(),
                name: "Custom endpoint".into(),
                base_url: base_url.into(),
                model_id: model_id.into(),
                context_limit: object
                    .get("openaiCompatibleContextLimit")
                    .and_then(Value::as_u64)
                    .unwrap_or(128_000),
            }]
        }
    };
    let snapshot = Snapshot {
        revision: 0,
        endpoints,
    };
    validate_snapshot(&snapshot)?;
    Ok(snapshot)
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
                let snapshot = serde_json::from_value(value)
                    .map_err(|e| format!("invalid endpoint store: {e}"))?;
                validate_snapshot(&snapshot)?;
                snapshot
            }
            None => {
                let snapshot = migrate(read_json(&directory.join("oarlock-settings.json"))?)?;
                // Publish the migration marker even for an empty list, before
                // caching. Old settings/plugin exit writes can never resurrect it.
                persist(&path, &snapshot)?;
                snapshot
            }
        };
        Ok(Self { path, snapshot })
    }
    #[cfg(test)]
    fn mutate(&mut self, change: Change, new_id: &str) -> Result<Snapshot, String> {
        self.mutate_with_key_cleanup(change, new_id, |_| Ok(()))
    }
    fn mutate_with_key_cleanup(
        &mut self,
        change: Change,
        new_id: &str,
        remove_key: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<Snapshot, String> {
        let removed = match &change {
            Change::Delete { id } => Some(id.clone()),
            _ => None,
        };
        let next = apply(&self.snapshot, change, new_id)?;
        if next != self.snapshot {
            // Validate the metadata change first. A failed key deletion leaves
            // the endpoint available for retry, even after partial key cleanup.
            if let Some(id) = removed {
                remove_key(&id)?;
            }
            persist(&self.path, &next)?;
            self.snapshot = next;
        }
        Ok(self.snapshot.clone())
    }
}
fn persist(path: &Path, value: &Snapshot) -> Result<(), String> {
    let parent = path.parent().ok_or("endpoint directory missing")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, value).map_err(|e| e.to_string())?;
    if file.as_file().metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("endpoint store exceeds 64 MiB".into());
    }
    file.flush().map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}
fn with_store<T>(
    app: &tauri::AppHandle,
    work: impl FnOnce(&mut Store) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<EndpointState>();
    let mut saved = state.0.lock().map_err(|e| e.to_string())?;
    if saved.is_none() {
        let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
        *saved = Some(Store::open(&directory).map_err(|e| format!("Custom endpoints could not be loaded. Files were preserved; repair them and retry. {e}"))?);
    }
    work(saved.as_mut().expect("opened store"))
}
fn transact(
    app: &tauri::AppHandle,
    change: Option<Change>,
    refresh: bool,
) -> Result<Snapshot, String> {
    with_store(app, |store| {
        let Some(change) = change else {
            if refresh {
                let _ = app.emit(EVENT, &store.snapshot);
            }
            return Ok(store.snapshot.clone());
        };
        let mut nonce = [0u8; 16];
        if matches!(change, Change::Create { .. }) {
            getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
        }
        let id = nonce.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let previous = store.snapshot.revision;
        let snapshot =
            store.mutate_with_key_cleanup(change, &id, |id| write_credential(app, id, None))?;
        if snapshot.revision != previous {
            let _ = app.emit(EVENT, &snapshot);
        }
        Ok(snapshot)
    })
}
#[tauri::command]
pub async fn ai_endpoints_snapshot(
    app: tauri::AppHandle,
    refresh: Option<bool>,
) -> Result<Snapshot, String> {
    super::fs::blocking(move || transact(&app, None, refresh.unwrap_or(false))).await
}
#[tauri::command]
pub async fn ai_endpoints_mutate(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    change: Change,
) -> Result<Snapshot, String> {
    if window.label() != "settings" {
        return Err("custom endpoints are edited in Settings".into());
    }
    super::fs::blocking(move || transact(&app, Some(change), false)).await
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum CredentialChange {
    Set {
        id: String,
        #[serde(rename = "baseURL")]
        base_url: String,
        key: String,
    },
    Clear {
        id: String,
    },
}
#[derive(Debug, PartialEq, Serialize)]
pub struct Credential {
    origin: String,
    key: String,
}
fn origin(url: &str) -> Result<String, String> {
    let url = tauri::Url::parse(url)
        .map_err(|_| "Enter an HTTP or HTTPS base URL before saving a key.")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(
            "Enter an HTTP or HTTPS base URL without embedded credentials before saving a key."
                .into(),
        );
    }
    Ok(url.origin().ascii_serialization())
}
fn prepare_credential(
    snapshot: &Snapshot,
    id: &str,
    base_url: &str,
    key: &str,
) -> Result<Credential, String> {
    let endpoint = snapshot
        .endpoints
        .iter()
        .find(|e| e.id == id)
        .ok_or("endpoint was removed; reopen Settings")?;
    let requested = origin(base_url)?;
    if requested != origin(&endpoint.base_url)? {
        return Err("endpoint origin changed; reopen its settings before saving a key".into());
    }
    let key = key.trim();
    if key.len() > super::secrets::MAX_VALUE_BYTES {
        return Err("endpoint credential is too large".into());
    }
    if key.is_empty() {
        return Err("API key is empty".into());
    }
    Ok(Credential {
        origin: requested,
        key: key.into(),
    })
}
fn change_credential(
    snapshot: &Snapshot,
    change: CredentialChange,
    write: impl FnOnce(&str, Option<String>) -> Result<(), String>,
) -> Result<Option<Credential>, String> {
    match change {
        CredentialChange::Set { id, base_url, key } => {
            let credential = prepare_credential(snapshot, &id, &base_url, &key)?;
            let encoded = serde_json::to_string(&serde_json::json!({"format":"oarlock-endpoint-key-v1", "origin":credential.origin, "key":credential.key})).map_err(|e| e.to_string())?;
            if encoded.len() > super::secrets::MAX_VALUE_BYTES {
                return Err("endpoint credential is too large".into());
            }
            write(&id, Some(encoded))?;
            Ok(Some(credential))
        }
        CredentialChange::Clear { id } => {
            if !valid_id(&id) {
                return Err("invalid endpoint identity".into());
            }
            // Also permits cleaning an orphan left by an older app version.
            write(&id, None)?;
            Ok(None)
        }
    }
}
fn write_credential(app: &tauri::AppHandle, id: &str, value: Option<String>) -> Result<(), String> {
    let secrets = app.state::<super::secrets::SecretsState>();
    let account = format!("compat-{id}-api-key");
    // Lock order is endpoint gate -> secrets gate; no secrets operation takes
    // the endpoint gate while holding its own lock.
    let result = match value {
        Some(value) => super::secrets::set_secret(app, &secrets, "oarlock-ai", &account, value),
        None => super::secrets::delete_secret(app, &secrets, "oarlock-ai", &account),
    };
    // Deletion may remove the head before chunk cleanup fails. Invalidate all
    // caches even on failure, and before a later metadata save can fail.
    let _ = app.emit("oarlock://ai-keys-changed", ());
    result
}
#[tauri::command]
pub async fn ai_endpoint_credential(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    change: CredentialChange,
) -> Result<Option<Credential>, String> {
    if window.label() != "settings" {
        return Err("custom endpoints are edited in Settings".into());
    }
    super::fs::blocking(move || {
        with_store(&app, |store| {
            change_credential(&store.snapshot, change, |id, value| {
                write_credential(&app, id, value)
            })
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn endpoint(id: &str) -> Endpoint {
        Endpoint {
            id: id.into(),
            name: "Original".into(),
            base_url: "https://one.example/v1".into(),
            model_id: "old-model".into(),
            context_limit: 128_000,
        }
    }
    fn change(value: Value) -> Change {
        serde_json::from_value(value).unwrap()
    }
    fn update(id: &str, patch: Value) -> Change {
        change(json!({"kind":"update","id":id,"patch":patch}))
    }
    fn seeded(directory: &Path) -> Store {
        let mut store = Store::open(directory).unwrap();
        let mut fields = serde_json::to_value(endpoint("ignored")).unwrap();
        fields.as_object_mut().unwrap().remove("id");
        store
            .mutate(change(json!({"kind":"create","endpoint":fields})), "a")
            .unwrap();
        store
    }
    fn save_key(id: &str, url: &str) -> CredentialChange {
        CredentialChange::Set {
            id: id.into(),
            base_url: url.into(),
            key: " secret ".into(),
        }
    }
    #[test]
    fn credential_saves_validate_identity_origin_and_format_before_writing() {
        let dir = tempfile::tempdir().unwrap();
        let store = seeded(dir.path());
        let key = change_credential(&store.snapshot, save_key("a", "https://ONE.example:443/other"), |id, value| {
            assert_eq!(id, "a");
            assert_eq!(serde_json::from_str::<Value>(&value.unwrap()).unwrap(), json!({"format":"oarlock-endpoint-key-v1","origin":"https://one.example","key":"secret"}));
            Ok(())
        }).unwrap().unwrap();
        assert_eq!(key.origin, "https://one.example");
        for change in [
            save_key("deleted", "https://one.example"),
            save_key("a", "https://other.example"),
            save_key("a", "http://one.example"),
            save_key("a", "https://one.example:444"),
            save_key("a", "https://user:pass@one.example"),
            save_key("a", "file:///tmp/key"),
            CredentialChange::Set {
                id: "a".into(),
                base_url: "https://one.example".into(),
                key: " ".into(),
            },
            CredentialChange::Set {
                id: "a".into(),
                base_url: "https://one.example".into(),
                key: "x".repeat(super::super::secrets::MAX_VALUE_BYTES),
            },
            CredentialChange::Clear {
                id: "a:gen:0".into(),
            },
        ] {
            assert!(change_credential(&store.snapshot, change, |_, _| panic!(
                "must reject before keychain access"
            ))
            .is_err());
        }
        let disk = std::fs::read_to_string(&store.path).unwrap();
        assert!(!disk.contains("secret"));
    }
    #[test]
    fn failed_key_cleanup_preserves_endpoint_and_metadata_failure_does_not_restore_deleted_keys() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = seeded(dir.path());
        let before = store.snapshot.clone();
        let bytes = std::fs::read(&store.path).unwrap();
        let deletion = || change(json!({"kind":"delete","id":"a"}));
        assert!(store
            .mutate_with_key_cleanup(deletion(), "", |_| Err("keychain locked".into()))
            .is_err());
        assert_eq!(store.snapshot, before);
        assert_eq!(std::fs::read(&store.path).unwrap(), bytes);
        // The keychain may have removed a head before failing to remove chunks.
        let mut key = Some("secret");
        assert!(store
            .mutate_with_key_cleanup(deletion(), "", |_| {
                key = None;
                Err("chunk cleanup failed".into())
            })
            .is_err());
        assert_eq!(store.snapshot, before);
        assert!(key.is_none());
        key = Some("secret");
        std::fs::remove_file(&store.path).unwrap();
        std::fs::create_dir(&store.path).unwrap();
        assert!(store
            .mutate_with_key_cleanup(deletion(), "", |_| {
                key = None;
                Ok(())
            })
            .is_err());
        assert!(key.is_none());
        assert_eq!(store.snapshot, before);
    }
    #[test]
    fn a_save_in_progress_finishes_before_deletion_and_later_saves_cannot_recreate_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = Mutex::new(seeded(dir.path()));
        let key = Mutex::new(None);
        let (entered, entered_rx) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let store_ref = &store;
            let key_ref = &key;
            scope.spawn(move || {
                let store = store_ref.lock().unwrap();
                change_credential(
                    &store.snapshot,
                    save_key("a", "https://one.example"),
                    |_, value| {
                        entered.send(()).unwrap();
                        release_rx.recv().unwrap();
                        *key_ref.lock().unwrap() = value;
                        Ok(())
                    },
                )
                .unwrap();
            });
            entered_rx.recv().unwrap();
            scope.spawn(|| {
                store
                    .lock()
                    .unwrap()
                    .mutate_with_key_cleanup(change(json!({"kind":"delete","id":"a"})), "", |_| {
                        *key.lock().unwrap() = None;
                        Ok(())
                    })
                    .unwrap();
            });
            release.send(()).unwrap();
        });
        assert!(key.lock().unwrap().is_none());
        let snapshot = &store.lock().unwrap().snapshot;
        assert!(snapshot.endpoints.is_empty());
        assert!(change_credential(
            snapshot,
            save_key("a", "https://one.example"),
            |_, _| panic!("deleted identity must not write")
        )
        .is_err());
        assert!(Store::open(dir.path())
            .unwrap()
            .snapshot
            .endpoints
            .is_empty());
    }
    #[test]
    fn browser_wire_fields_round_trip_through_migration_and_transactions() {
        let fields = json!({"name":"A","baseURL":"https://a.example/v1","modelId":"m","contextLimit":128000});
        let snapshot = migrate(Some(json!({"customEndpoints":[]}))).unwrap();
        let created = apply(
            &snapshot,
            change(json!({"kind":"create","endpoint":fields})),
            "a",
        )
        .unwrap();
        let updated = apply(
            &created,
            update("a", json!({"baseURL":"https://b.example/v1"})),
            "",
        )
        .unwrap();
        let serialized = serde_json::to_value(&updated).unwrap();
        assert_eq!(
            serialized["endpoints"][0]["baseURL"],
            "https://b.example/v1"
        );
        assert!(serialized["endpoints"][0].get("baseUrl").is_none());
        let migrated = migrate(Some(json!({"customEndpoints":serialized["endpoints"]}))).unwrap();
        assert_eq!(migrated.endpoints, updated.endpoints);
    }
    #[test]
    fn independent_field_edits_merge_and_deletion_rejects_stale_updates() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = seeded(dir.path());
        store
            .mutate(update("a", json!({"name":"Renamed"})), "")
            .unwrap();
        store
            .mutate(update("a", json!({"modelId":"new-model"})), "")
            .unwrap();
        assert_eq!(store.snapshot.endpoints[0].name, "Renamed");
        assert_eq!(store.snapshot.endpoints[0].model_id, "new-model");
        store
            .mutate(change(json!({"kind":"delete","id":"a"})), "")
            .unwrap();
        assert!(store
            .mutate(update("a", json!({"name":"resurrected"})), "")
            .is_err());
        let reopened = Store::open(dir.path()).unwrap();
        assert!(reopened.snapshot.endpoints.is_empty());
        assert_eq!(reopened.snapshot.revision, 4);
    }
    #[test]
    fn concurrent_transactions_preserve_other_fields_and_endpoints() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = seeded(dir.path());
        let mut fields = serde_json::to_value(endpoint("ignored")).unwrap();
        fields.as_object_mut().unwrap().remove("id");
        store
            .mutate(change(json!({"kind":"create","endpoint":fields})), "b")
            .unwrap();
        let store = Mutex::new(store);
        std::thread::scope(|scope| {
            for (id, patch) in [
                ("a", json!({"name":"New A"})),
                ("a", json!({"modelId":"new-a-model"})),
                ("b", json!({"name":"New B"})),
            ] {
                let store = &store;
                scope.spawn(move || {
                    store.lock().unwrap().mutate(update(id, patch), "").unwrap();
                });
            }
        });
        let final_state = &store.lock().unwrap().snapshot;
        assert_eq!(final_state.endpoints[0].name, "New A");
        assert_eq!(final_state.endpoints[0].model_id, "new-a-model");
        assert_eq!(final_state.endpoints[1].name, "New B");
    }
    #[test]
    fn invalid_patches_and_page_selected_identities_leave_the_store_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = seeded(dir.path());
        let before = std::fs::read(dir.path().join(FILE)).unwrap();
        for patch in [
            json!({"id":"b"}),
            json!({"contextLimit":null}),
            json!({"contextLimit":1}),
            json!({"baseURL":"a\u{0}b"}),
            json!({"key":"secret"}),
        ] {
            assert!(store.mutate(update("a", patch), "").is_err());
        }
        assert!(store
            .mutate(
                change(json!({"kind":"create","endpoint":endpoint("chosen")})),
                "generated"
            )
            .is_err());
        assert_eq!(std::fs::read(dir.path().join(FILE)).unwrap(), before);
        assert_eq!(store.snapshot.endpoints, vec![endpoint("a")]);
    }
    #[test]
    fn migration_keeps_ids_and_is_never_replayed_after_deletion_or_legacy_rewrites() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("oarlock-settings.json");
        let bytes =
            serde_json::to_vec(&json!({"customEndpoints":[endpoint("a")],"other":"kept"})).unwrap();
        std::fs::write(&legacy, &bytes).unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        assert_eq!(store.snapshot.endpoints, vec![endpoint("a")]);
        assert_eq!(std::fs::read(&legacy).unwrap(), bytes);
        store
            .mutate(change(json!({"kind":"delete","id":"a"})), "")
            .unwrap();
        drop(store);
        // The plugin still owns the old settings file and can rewrite it on exit.
        std::fs::write(&legacy, &bytes).unwrap();
        assert!(Store::open(dir.path())
            .unwrap()
            .snapshot
            .endpoints
            .is_empty());
    }
    #[test]
    fn legacy_single_endpoint_and_explicit_empty_list_keep_their_meanings() {
        let old = json!({"openaiCompatibleBaseURL":"https://one.example/v1","openaiCompatibleModelId":"m"});
        let first = migrate(Some(old.clone())).unwrap();
        assert_eq!(first.endpoints[0].id, "legacy");
        assert_eq!(first.endpoints[0].context_limit, 128_000);
        let mut removed = old;
        removed["customEndpoints"] = json!([]);
        assert!(migrate(Some(removed)).unwrap().endpoints.is_empty());
        for incomplete in [
            json!({"openaiCompatibleBaseURL":"", "openaiCompatibleModelId":"m"}),
            json!({"openaiCompatibleBaseURL":"https://one.example", "openaiCompatibleModelId":"  "}),
        ] {
            assert!(migrate(Some(incomplete)).unwrap().endpoints.is_empty());
        }
    }
    #[test]
    fn damaged_files_are_preserved_and_never_replaced_by_an_empty_migration() {
        for file in [FILE, "oarlock-settings.json"] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(file);
            for content in ["{damaged", "[]", "{\"customEndpoints\":false}"] {
                std::fs::write(&path, content).unwrap();
                assert!(Store::open(dir.path()).is_err());
                assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
                if file != FILE {
                    assert!(!dir.path().join(FILE).exists());
                }
            }
        }
    }
    #[test]
    fn failed_commit_keeps_memory_and_removes_its_staging_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = seeded(dir.path());
        let before = store.snapshot.clone();
        std::fs::remove_file(&store.path).unwrap();
        std::fs::create_dir(&store.path).unwrap();
        assert!(store
            .mutate(update("a", json!({"name":"lost"})), "")
            .is_err());
        assert_eq!(store.snapshot, before);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[cfg(unix)]
    #[test]
    fn dangling_symlinks_are_not_missing_stores() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        std::os::unix::fs::symlink(dir.path().join("missing"), &path).unwrap();
        assert!(Store::open(dir.path()).is_err());
        assert!(std::fs::symlink_metadata(path).unwrap().is_symlink());
    }
}
