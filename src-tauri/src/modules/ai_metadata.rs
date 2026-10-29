//! Shared chat metadata. Every mutation is applied to the current native list,
//! under one process-wide lock. Windows never replace each other's snapshots.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::{Emitter, State};
use tauri_plugin_store::StoreExt;

const STORE: &str = "oarlock-ai-sessions.json";
#[derive(Default)]
pub struct MetadataState(std::sync::Mutex<u64>);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Delta {
    creates: Vec<Value>,
    updates: Vec<Update>,
    deletes: Vec<String>,
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
fn apply(
    sessions: &mut Vec<Value>,
    deleted: &mut HashSet<String>,
    delta: Delta,
) -> Result<(), String> {
    if delta.creates.len() + delta.updates.len() + delta.deletes.len() > 256 {
        return Err("too many conversation changes".into());
    }
    // Validate the complete transaction before changing anything.
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
    deleted.extend(delta.deletes);
    sessions.retain(|s| !s["id"].as_str().is_some_and(|id| deleted.contains(id)));
    for update in delta.updates {
        if let Some(object) = sessions
            .iter_mut()
            .find(|s| s["id"] == update.id)
            .and_then(Value::as_object_mut)
        {
            object.extend(update.patch);
        }
    }
    for value in delta.creates.into_iter().rev() {
        let id = value["id"].as_str().ok_or("invalid conversation id")?;
        if !deleted.contains(id) && !sessions.iter().any(|s| s["id"] == id) {
            sessions.insert(0, value);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_sessions_snapshot(
    app: tauri::AppHandle,
    state: State<'_, MetadataState>,
) -> Result<Snapshot, String> {
    // Store access is memory-only after loading. The same gate orders snapshots,
    // transactions and their events; the plugin retains its existing autosave.
    let revision = state.0.lock().map_err(|e| e.to_string())?;
    let store = app.store(STORE).map_err(|e| e.to_string())?;
    let sessions = serde_json::from_value(store.get("sessions").unwrap_or(json!([])))
        .map_err(|e| e.to_string())?;
    Ok(Snapshot {
        revision: *revision,
        sessions,
    })
}

#[tauri::command]
pub async fn ai_sessions_mutate(
    app: tauri::AppHandle,
    state: State<'_, MetadataState>,
    delta: Delta,
) -> Result<Snapshot, String> {
    let mut revision = state.0.lock().map_err(|e| e.to_string())?;
    let store = app.store(STORE).map_err(|e| e.to_string())?;
    let mut sessions = serde_json::from_value(store.get("sessions").unwrap_or(json!([])))
        .map_err(|e| e.to_string())?;
    let mut deleted = serde_json::from_value(store.get("deletedSessions").unwrap_or(json!([])))
        .map_err(|e| e.to_string())?;
    apply(&mut sessions, &mut deleted, delta)?;
    let next = revision
        .checked_add(1)
        .ok_or("conversation revision exhausted")?;
    // Tombstones prevent an older window's queued creation from reviving a deletion.
    store.set("deletedSessions", json!(deleted));
    store.set("sessions", json!(sessions));
    *revision = next;
    let snapshot = Snapshot {
        revision: next,
        sessions,
    };
    let _ = app.emit("ai:sessions-changed", &snapshot);
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn create(id: &str) -> Delta {
        Delta {
            creates: vec![json!({"id":id,"title":id,"createdAt":1,"updatedAt":1})],
            updates: vec![],
            deletes: vec![],
        }
    }
    #[test]
    fn independent_windows_keep_both_creations_and_merge_fields() {
        let mut sessions = vec![];
        let mut deleted = HashSet::new();
        apply(&mut sessions, &mut deleted, create("a")).unwrap();
        apply(&mut sessions, &mut deleted, create("b")).unwrap();
        for patch in [json!({"title":"renamed"}), json!({"approvalMode":"auto"})] {
            apply(
                &mut sessions,
                &mut deleted,
                Delta {
                    creates: vec![],
                    deletes: vec![],
                    updates: vec![Update {
                        id: "a".into(),
                        patch: patch.as_object().unwrap().clone(),
                    }],
                },
            )
            .unwrap();
        }
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[1]["title"], "renamed");
        assert_eq!(sessions[1]["approvalMode"], "auto");
    }
    #[test]
    fn stale_updates_and_creations_cannot_revive_deleted_chats() {
        let mut sessions = vec![];
        let mut deleted = HashSet::new();
        apply(&mut sessions, &mut deleted, create("a")).unwrap();
        apply(
            &mut sessions,
            &mut deleted,
            Delta {
                creates: vec![],
                updates: vec![],
                deletes: vec!["a".into()],
            },
        )
        .unwrap();
        apply(&mut sessions, &mut deleted, create("a")).unwrap();
        assert!(sessions.is_empty());
    }
    #[test]
    fn invalid_transaction_changes_nothing() {
        let mut sessions = vec![json!({"id":"a"})];
        let mut deleted = HashSet::new();
        let bad = Delta {
            creates: vec![json!({"id":"bad"})],
            updates: vec![],
            deletes: vec!["a".into()],
        };
        assert!(apply(&mut sessions, &mut deleted, bad).is_err());
        assert_eq!(sessions.len(), 1);
        assert!(deleted.is_empty());
    }
}
