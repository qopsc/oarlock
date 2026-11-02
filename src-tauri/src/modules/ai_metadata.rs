//! Shared chat metadata. Every mutation is applied to the current native list,
//! under one process-wide lock, and saved before it is published. Windows never
//! replace each other's snapshots.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

const STORE: &str = "oarlock-ai-sessions.json";
const GATE_KEY: &str = "sessionsGate";
const LEGACY_TOMBSTONES: &str = "deletedSessions";
const MAX_TOMBSTONES: usize = 256;

#[derive(Default)]
pub struct MetadataState(std::sync::Mutex<()>);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Delta {
    creates: Vec<Value>,
    updates: Vec<Update>,
    deletes: Vec<String>,
    base: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Update {
    id: String,
    patch: serde_json::Map<String, Value>,
}
#[derive(Clone, Serialize)]
pub struct Snapshot {
    revision: u64,
    sessions: Vec<Value>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct MetadataDoc {
    sessions: Vec<Value>,
    tombstones: VecDeque<(String, u64)>,
    evicted_through: Option<u64>,
    revision: u64,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn validate_field(key: &str, value: &Value) -> bool {
    match key {
        "title" => value.as_str().is_some_and(|s| s.len() <= 16_384),
        "createdAt" | "updatedAt" => value.as_u64().is_some(),
        "approvalMode" => matches!(value.as_str(), Some("ask" | "auto")),
        _ => false,
    }
}

impl MetadataDoc {
    fn tombstoned(&self, id: &str) -> bool {
        self.tombstones.iter().any(|(t, _)| t == id)
    }

    fn apply(&mut self, delta: Delta) -> Result<(), String> {
        if delta.creates.len() + delta.updates.len() + delta.deletes.len() > 256 {
            return Err("too many conversation changes".into());
        }
        for value in &delta.creates {
            let object = value.as_object().ok_or("invalid conversation")?;
            if !object
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(valid_id)
                || !["title", "createdAt", "updatedAt"]
                    .iter()
                    .all(|k| object.contains_key(*k))
                || object
                    .iter()
                    .any(|(k, v)| k != "id" && !validate_field(k, v))
            {
                return Err("invalid conversation metadata".into());
            }
        }
        if delta.deletes.iter().any(|id| !valid_id(id))
            || delta
                .updates
                .iter()
                .any(|u| !valid_id(&u.id) || u.patch.iter().any(|(k, v)| !validate_field(k, v)))
        {
            return Err("invalid conversation update".into());
        }
        let next = self
            .revision
            .checked_add(1)
            .ok_or("conversation revision exhausted")?;
        for id in delta.deletes {
            self.tombstones.retain(|(t, _)| *t != id);
            self.tombstones.push_back((id, next));
        }
        while self.tombstones.len() > MAX_TOMBSTONES {
            if let Some((_, revision)) = self.tombstones.pop_front() {
                self.evicted_through = Some(self.evicted_through.map_or(revision, |e| e.max(revision)));
            }
        }
        let deleted: Vec<String> = self.tombstones.iter().map(|(id, _)| id.clone()).collect();
        self.sessions
            .retain(|s| !s["id"].as_str().is_some_and(|id| deleted.iter().any(|d| d == id)));
        for update in delta.updates {
            if let Some(object) = self
                .sessions
                .iter_mut()
                .find(|s| s["id"] == update.id)
                .and_then(Value::as_object_mut)
            {
                object.extend(update.patch);
            }
        }
        // A page that missed a deletion whose tombstone was evicted cannot prove its create is new.
        let stale = self.evicted_through.is_some_and(|e| delta.base < e);
        for value in delta.creates.into_iter().rev() {
            let id = value["id"].as_str().ok_or("invalid conversation id")?;
            if !self.tombstoned(id) && !self.sessions.iter().any(|s| s["id"] == id) && !stale {
                self.sessions.insert(0, value);
            }
        }
        self.revision = next;
        Ok(())
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            revision: self.revision,
            sessions: self.sessions.clone(),
        }
    }
}

pub trait DocStore {
    fn load(&self) -> Result<MetadataDoc, String>;
    fn save(&self, doc: &MetadataDoc) -> Result<(), String>;
}

fn gate_json(doc: &MetadataDoc) -> Value {
    json!({
        "revision": doc.revision,
        "evictedThrough": doc.evicted_through,
        "tombstones": doc.tombstones.iter().map(|(id, revision)| json!({"id": id, "revision": revision})).collect::<Vec<_>>(),
    })
}

pub fn parse_doc(
    sessions: Option<Value>,
    gate: Option<Value>,
    legacy: Option<Value>,
) -> Result<MetadataDoc, String> {
    let sessions: Vec<Value> =
        serde_json::from_value(sessions.unwrap_or(json!([]))).map_err(|e| e.to_string())?;
    let mut doc = MetadataDoc {
        sessions,
        ..Default::default()
    };
    if let Some(gate) = gate {
        let invalid = || "invalid conversation gate".to_string();
        doc.revision = gate["revision"].as_u64().ok_or_else(invalid)?;
        doc.evicted_through = match &gate["evictedThrough"] {
            Value::Null => None,
            v => Some(v.as_u64().ok_or_else(invalid)?),
        };
        for t in gate["tombstones"].as_array().ok_or_else(invalid)? {
            let id = t["id"].as_str().filter(|id| valid_id(id)).ok_or_else(invalid)?;
            doc.tombstones
                .push_back((id.into(), t["revision"].as_u64().ok_or_else(invalid)?));
        }
        if doc.tombstones.len() > MAX_TOMBSTONES
            || doc.evicted_through.is_some_and(|e| e > doc.revision)
        {
            return Err(invalid());
        }
        let highest = doc.tombstones.iter().map(|(_, r)| *r).max().unwrap_or(0);
        doc.revision = doc.revision.max(highest);
    } else if let Some(legacy) = legacy {
        let ids: Vec<String> = serde_json::from_value(legacy).map_err(|e| e.to_string())?;
        for id in ids.into_iter().filter(|id| valid_id(id)) {
            if !doc.tombstones.iter().any(|(t, _)| *t == id) {
                doc.tombstones.push_back((id, 0));
            }
        }
        while doc.tombstones.len() > MAX_TOMBSTONES {
            doc.tombstones.pop_front();
        }
    }
    Ok(doc)
}

struct PluginDocStore(tauri::AppHandle);
impl DocStore for PluginDocStore {
    fn load(&self) -> Result<MetadataDoc, String> {
        let store = self.0.store(STORE).map_err(|e| e.to_string())?;
        parse_doc(
            store.get("sessions"),
            store.get(GATE_KEY),
            store.get(LEGACY_TOMBSTONES),
        )
    }
    fn save(&self, doc: &MetadataDoc) -> Result<(), String> {
        let store = self.0.store(STORE).map_err(|e| e.to_string())?;
        let before = [
            (GATE_KEY, store.get(GATE_KEY)),
            ("sessions", store.get("sessions")),
            (LEGACY_TOMBSTONES, store.get(LEGACY_TOMBSTONES)),
        ];
        store.set(GATE_KEY, gate_json(doc));
        store.set("sessions", json!(doc.sessions));
        store.delete(LEGACY_TOMBSTONES);
        store.save().map_err(|error| {
            for (key, value) in before {
                match value {
                    Some(value) => store.set(key, value),
                    None => {
                        store.delete(key);
                    }
                }
            }
            error.to_string()
        })
    }
}

/// Applies one transaction and saves it; nothing is published before the save succeeds.
pub fn mutate_doc(store: &impl DocStore, delta: Delta) -> Result<MetadataDoc, String> {
    let mut doc = store.load()?;
    doc.apply(delta)?;
    store.save(&doc)?;
    Ok(doc)
}

#[tauri::command]
pub async fn ai_sessions_snapshot(
    app: tauri::AppHandle,
    _state: tauri::State<'_, MetadataState>,
) -> Result<Snapshot, String> {
    crate::modules::fs::blocking(move || {
        let state = app.state::<MetadataState>();
        let _gate = state.0.lock().unwrap_or_else(|e| e.into_inner());
        Ok(PluginDocStore(app.clone()).load()?.snapshot())
    })
    .await
}

#[tauri::command]
pub async fn ai_sessions_mutate(
    app: tauri::AppHandle,
    _state: tauri::State<'_, MetadataState>,
    delta: Delta,
) -> Result<Snapshot, String> {
    let emitter = app.clone();
    let snapshot = crate::modules::fs::blocking(move || {
        let state = app.state::<MetadataState>();
        let _gate = state.0.lock().unwrap_or_else(|e| e.into_inner());
        mutate_doc(&PluginDocStore(app.clone()), delta).map(|doc| doc.snapshot())
    })
    .await?;
    let _ = emitter.emit("ai:sessions-changed", &snapshot);
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct FileDocStore(std::path::PathBuf, Cell<bool>);
    impl FileDocStore {
        fn new(path: std::path::PathBuf) -> Self {
            Self(path, Cell::new(false))
        }
    }
    impl DocStore for FileDocStore {
        fn load(&self) -> Result<MetadataDoc, String> {
            let map: serde_json::Map<String, Value> = match std::fs::read(&self.0) {
                Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
                Err(_) => Default::default(),
            };
            parse_doc(
                map.get("sessions").cloned(),
                map.get(GATE_KEY).cloned(),
                map.get(LEGACY_TOMBSTONES).cloned(),
            )
        }
        fn save(&self, doc: &MetadataDoc) -> Result<(), String> {
            if self.1.get() {
                return Err("disk full".into());
            }
            let mut map: serde_json::Map<String, Value> = match std::fs::read(&self.0) {
                Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
                Err(_) => Default::default(),
            };
            map.insert(GATE_KEY.into(), gate_json(doc));
            map.insert("sessions".into(), json!(doc.sessions));
            map.remove(LEGACY_TOMBSTONES);
            let tmp = self.0.with_extension("tmp");
            let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
            serde_json::to_writer(&file, &map).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &self.0).map_err(|e| e.to_string())
        }
    }

    fn create(id: &str, base: u64) -> Delta {
        Delta {
            creates: vec![json!({"id":id,"title":id,"createdAt":1,"updatedAt":1})],
            updates: vec![],
            deletes: vec![],
            base,
        }
    }
    fn delete(id: &str) -> Delta {
        Delta {
            creates: vec![],
            updates: vec![],
            deletes: vec![id.into()],
            base: 0,
        }
    }
    fn ids(doc: &MetadataDoc) -> Vec<String> {
        doc.sessions
            .iter()
            .map(|s| s["id"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn independent_windows_keep_both_creations_and_merge_fields() {
        let mut doc = MetadataDoc::default();
        doc.apply(create("a", 0)).unwrap();
        doc.apply(create("b", 0)).unwrap();
        for patch in [json!({"title":"renamed"}), json!({"approvalMode":"auto"})] {
            doc.apply(Delta {
                creates: vec![],
                deletes: vec![],
                updates: vec![Update {
                    id: "a".into(),
                    patch: patch.as_object().unwrap().clone(),
                }],
                base: 0,
            })
            .unwrap();
        }
        assert_eq!(doc.sessions.len(), 2);
        assert_eq!(doc.sessions[1]["title"], "renamed");
        assert_eq!(doc.sessions[1]["approvalMode"], "auto");
    }

    #[test]
    fn stale_updates_and_creations_cannot_revive_deleted_chats() {
        let mut doc = MetadataDoc::default();
        doc.apply(create("a", 0)).unwrap();
        doc.apply(delete("a")).unwrap();
        doc.apply(create("a", 0)).unwrap();
        assert!(doc.sessions.is_empty());
    }

    #[test]
    fn invalid_transaction_changes_nothing() {
        let mut doc = MetadataDoc {
            sessions: vec![json!({"id":"a"})],
            ..Default::default()
        };
        let bad = Delta {
            creates: vec![json!({"id":"bad"})],
            updates: vec![],
            deletes: vec!["a".into()],
            base: 0,
        };
        assert!(doc.apply(bad).is_err());
        assert_eq!(doc.sessions.len(), 1);
        assert!(doc.tombstones.is_empty());
    }

    #[test]
    fn a_mutation_is_on_disk_before_the_command_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileDocStore::new(dir.path().join("chats.json"));
        mutate_doc(&store, create("new", 0)).unwrap();
        let reloaded = FileDocStore::new(dir.path().join("chats.json")).load().unwrap();
        assert_eq!(ids(&reloaded), ["new"]);
        assert_eq!(reloaded.revision, 1);
    }

    #[test]
    fn a_failed_save_changes_nothing_and_publishes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileDocStore::new(dir.path().join("chats.json"));
        mutate_doc(&store, create("kept", 0)).unwrap();
        store.1.set(true);
        assert!(mutate_doc(&store, create("lost", 1)).is_err());
        store.1.set(false);
        let doc = store.load().unwrap();
        assert_eq!(ids(&doc), ["kept"]);
        assert_eq!(doc.revision, 1);
    }

    #[test]
    fn a_deletion_from_another_window_is_not_resurrected_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chats.json");
        let store = FileDocStore::new(path.clone());
        mutate_doc(&store, create("a", 0)).unwrap();
        mutate_doc(&store, delete("a")).unwrap();
        let restarted = FileDocStore::new(path);
        let doc = mutate_doc(&restarted, create("a", 1)).unwrap();
        assert!(doc.sessions.is_empty());
    }

    #[test]
    fn the_tombstone_set_never_exceeds_its_bound() {
        let mut doc = MetadataDoc::default();
        for n in 0..300 {
            doc.apply(delete(&format!("c{n}"))).unwrap();
            assert!(doc.tombstones.len() <= MAX_TOMBSTONES);
        }
        assert_eq!(doc.tombstones.len(), MAX_TOMBSTONES);
        assert_eq!(doc.evicted_through, Some(44));
    }

    #[test]
    fn a_creation_older_than_the_oldest_kept_tombstone_is_refused_by_revision() {
        let mut doc = MetadataDoc::default();
        for n in 0..300 {
            doc.apply(delete(&format!("c{n}"))).unwrap();
        }
        doc.apply(create("old-window", 10)).unwrap();
        assert!(doc.sessions.is_empty());
        doc.apply(create("current-window", doc.revision)).unwrap();
        assert_eq!(ids(&doc), ["current-window"]);
    }

    #[test]
    fn a_retried_creation_keeps_the_base_it_was_enqueued_with() {
        let mut doc = MetadataDoc::default();
        let enqueued_at = doc.revision;
        doc.apply(delete("retried")).unwrap();
        for n in 0..257 {
            doc.apply(delete(&format!("c{n}"))).unwrap();
        }
        doc.apply(create("retried", enqueued_at)).unwrap();
        assert!(doc.sessions.is_empty());
    }

    #[test]
    fn a_creation_at_revision_zero_is_kept() {
        let mut doc = MetadataDoc::default();
        doc.apply(create("first", 0)).unwrap();
        assert_eq!(ids(&doc), ["first"]);
        let mut legacy = parse_doc(None, None, Some(json!(["gone"]))).unwrap();
        legacy.apply(create("first", 0)).unwrap();
        assert_eq!(ids(&legacy), ["first"]);
        legacy.apply(create("gone", 0)).unwrap();
        assert_eq!(ids(&legacy), ["first"]);
    }

    #[test]
    fn legacy_string_tombstones_load_and_are_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chats.json");
        std::fs::write(&path, r#"{"sessions":[],"deletedSessions":["x"]}"#).unwrap();
        let store = FileDocStore::new(path.clone());
        mutate_doc(&store, create("a", 0)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("deletedSessions"));
        assert!(store.load().unwrap().tombstoned("x"));
    }

    #[test]
    fn revision_survives_a_restart_and_a_damaged_gate_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileDocStore::new(dir.path().join("chats.json"));
        mutate_doc(&store, create("a", 0)).unwrap();
        mutate_doc(&store, create("b", 1)).unwrap();
        assert_eq!(store.load().unwrap().revision, 2);
        assert!(parse_doc(None, Some(json!({"revision":1,"evictedThrough":5,"tombstones":[]})), None).is_err());
        let clamped = parse_doc(
            None,
            Some(json!({"revision":0,"evictedThrough":null,"tombstones":[{"id":"a","revision":7}]})),
            None,
        )
        .unwrap();
        assert_eq!(clamped.revision, 7);
    }

    #[test]
    fn the_plugin_doc_store_saves_before_returning() {
        let source = include_str!("ai_metadata.rs");
        let start = source.find("impl DocStore for PluginDocStore").unwrap();
        let body = &source[start..source[start..].find("/// Applies one").unwrap() + start];
        assert!(body.contains("store.save()"));
        assert!(source.contains("crate::modules::fs::blocking"));
    }
}
