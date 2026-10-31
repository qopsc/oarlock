//! Settings mutations share one native lock; callers submit only edited fields.
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

pub(super) const STORE: &str = "oarlock-mcp.json";

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Patch {
    path: Vec<String>,
    #[serde(default)]
    value: Value,
    #[serde(default)]
    remove: bool,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Change {
    Tools {
        id: String,
        tools: Option<Value>,
    },
    Create {
        server: Value,
        #[serde(default)]
        secrets: Vec<super::credentials::Write>,
    },
    Update {
        id: String,
        patches: Vec<Patch>,
        expected: Option<super::credentials::Expected>,
        #[serde(default)]
        secrets: Vec<super::credentials::Write>,
    },
    Delete {
        id: String,
    },
    Project {
        id: String,
        #[serde(rename = "entryHash")]
        entry_hash: String,
        patches: Vec<Patch>,
    },
}

fn valid_text(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|s| s.len() <= max && !s.contains('\0'))
}

pub(super) fn valid_tools(value: &Value) -> bool {
    value.as_object().is_some_and(|tools| {
        tools.iter().all(|(key, value)| {
            !key.is_empty() && key.len() <= 4096 && matches!(value.as_str(), Some("allow" | "deny"))
        })
    })
}

fn valid_transport(value: &Value) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    match value["type"].as_str() {
        Some("stdio") => {
            fields
                .keys()
                .all(|k| matches!(k.as_str(), "type" | "command" | "args" | "env" | "cwd"))
                && valid_text(&value["command"], super::MAX_COMMAND_BYTES)
                && value["command"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty())
                && value["args"].as_array().is_some_and(|args| {
                    args.len() <= super::MAX_ARGS
                        && args.iter().all(|v| valid_text(v, super::MAX_ARG_BYTES))
                })
                && (value["cwd"].is_null() || valid_text(&value["cwd"], 32768))
                && valid_values(&value["env"], true)
        }
        Some("http" | "sse") => {
            fields
                .keys()
                .all(|k| matches!(k.as_str(), "type" | "url" | "headers" | "oauth"))
                && value["url"]
                    .as_str()
                    .and_then(|s| reqwest::Url::parse(s).ok())
                    .is_some_and(|u| {
                        matches!(u.scheme(), "http" | "https")
                            && u.host_str().is_some()
                            && u.username().is_empty()
                            && u.password().is_none()
                    })
                && valid_values(&value["headers"], false)
                && (value.get("oauth").is_none() || valid_oauth(&value["oauth"]))
        }
        _ => false,
    }
}

fn valid_values(value: &Value, env: bool) -> bool {
    value.as_array().is_some_and(|entries| {
        entries.len() <= super::MAX_ENTRIES
            && entries.iter().all(|entry| {
                let Some(fields) = entry.as_object() else {
                    return false;
                };
                fields
                    .keys()
                    .all(|k| matches!(k.as_str(), "name" | "secret" | "value"))
                    && entry["name"].as_str().is_some_and(|name| {
                        if env {
                            super::names::valid_env_name(name)
                        } else {
                            super::names::valid_header_name(name)
                        }
                    })
                    && match entry["secret"].as_bool() {
                        Some(true) => entry.get("value").is_none(),
                        Some(false) => valid_text(&entry["value"], 65536),
                        None => false,
                    }
            })
    })
}

fn valid_oauth(value: &Value) -> bool {
    value.as_object().is_some_and(|fields| {
        fields.keys().all(|k| {
            matches!(
                k.as_str(),
                "clientId" | "clientSecret" | "scopes" | "callbackPort"
            )
        }) && valid_text(&value["clientId"], 4096)
            && value["clientSecret"].is_boolean()
            && (value["scopes"].is_null() || valid_text(&value["scopes"], 4096))
            && (value["callbackPort"].is_null()
                || value["callbackPort"]
                    .as_u64()
                    .is_some_and(|p| (1..=65535).contains(&p)))
    })
}

pub(super) fn validate_server(server: &Value) -> Result<(), String> {
    let valid = server.as_object().is_some_and(|fields| {
        fields.keys().all(|k| {
            matches!(
                k.as_str(),
                "id" | "name"
                    | "source"
                    | "enabled"
                    | "trusted"
                    | "transport"
                    | "tools"
                    | "secretsRevision"
                    | "credentialVersion"
            )
        }) && server["id"]
            .as_str()
            .is_some_and(|id| super::names::valid_server_id(id) && !id.starts_with("prj-"))
            && server["name"].as_str().is_some_and(|s| {
                !s.trim().is_empty() && s.chars().count() <= 64 && !s.chars().any(char::is_control)
            })
            && server["source"]
                .as_str()
                .is_some_and(|s| s == "settings" || s.starts_with("imported:"))
            && server["enabled"].is_boolean()
            && server["trusted"].is_boolean()
            && valid_transport(&server["transport"])
            && valid_tools(&server["tools"])
            && server["secretsRevision"]
                .as_u64()
                .is_some_and(|v| v <= 9_007_199_254_740_991)
    });
    if valid {
        Ok(())
    } else {
        Err("mcp: invalid server settings".into())
    }
}

fn supply_defaults(value: &mut Value, defaults: Value) -> Result<(), String> {
    let object = value
        .as_object_mut()
        .ok_or("mcp: stored settings are not an object")?;
    if let Value::Object(defaults) = defaults {
        for (key, value) in defaults {
            object.entry(key).or_insert(value);
        }
    }
    Ok(())
}

pub(super) fn stored_server_defaults(server: &mut Value) -> Result<(), String> {
    supply_defaults(
        server,
        json!({"source":"settings","enabled":false,"trusted":false,"tools":{},"secretsRevision":0}),
    )?;
    match server["transport"]["type"].as_str() {
        Some("stdio") => {
            supply_defaults(
                &mut server["transport"],
                json!({"args":[],"env":[],"cwd":null}),
            )?;
            // Match parseTransport: imports may retain an empty optional cwd.
            if server["transport"]["cwd"]
                .as_str()
                .is_some_and(|cwd| cwd.trim().is_empty())
            {
                server["transport"]["cwd"] = Value::Null;
            }
            Ok(())
        }
        Some("http" | "sse") => {
            supply_defaults(&mut server["transport"], json!({"headers":[]}))?;
            if let Some(oauth) = server["transport"].get_mut("oauth") {
                supply_defaults(
                    oauth,
                    json!({"clientSecret":false,"scopes":null,"callbackPort":null}),
                )?;
                // The editor trims these optional OAuth inputs on read. Compare the
                // same effective transport before enforcing the revision check.
                if let Some(client_id) = oauth["clientId"].as_str() {
                    oauth["clientId"] = json!(client_id.trim());
                }
                if let Some(scopes) = oauth["scopes"].as_str() {
                    oauth["scopes"] = if scopes.trim().is_empty() {
                        Value::Null
                    } else {
                        json!(scopes.trim())
                    };
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn patch(target: &mut Value, patches: Vec<Patch>, project: bool) -> Result<(), String> {
    if patches.len() > 1024 {
        return Err("mcp: too many field changes".into());
    }
    for change in patches {
        let path = &change.path;
        let valid = match path.first().map(String::as_str) {
            Some("enabled" | "trusted") => path.len() == 1 && !change.remove,
            Some("tools") => path.len() == 2 && !path[1].is_empty() && path[1].len() <= 4096,
            Some("name") => !project && path.len() == 1 && !change.remove,
            Some("transport") => {
                !project && (1..=3).contains(&path.len()) && !(path.len() == 1 && change.remove)
            }
            _ => false,
        };
        if !valid {
            return Err("mcp: invalid settings field".into());
        }
        let mut at = &mut *target;
        for key in &path[..path.len() - 1] {
            let object = at
                .as_object_mut()
                .ok_or("mcp: settings field changed type; reopen the editor")?;
            at = object.entry(key).or_insert_with(|| json!({}));
        }
        let object = at.as_object_mut().ok_or("mcp: invalid settings object")?;
        let key = path.last().unwrap();
        if change.remove {
            object.remove(key);
        } else {
            object.insert(key.clone(), change.value);
        }
    }
    Ok(())
}

fn apply(
    servers: &mut Vec<Value>,
    records: &mut serde_json::Map<String, Value>,
    changes: Vec<Change>,
) -> Result<(), String> {
    if changes.len() > 256 {
        return Err("mcp: too many settings changes".into());
    }
    for change in changes {
        match change {
            Change::Tools { id, tools } => {
                if !super::names::valid_server_id(&id)
                    || tools.as_ref().is_some_and(|tools| {
                        !tools.as_array().is_some_and(|tools| tools.len() <= 500)
                    })
                {
                    return Err("mcp: invalid tool cache".into());
                }
            }
            Change::Create { server, .. } => {
                if server.get("credentialVersion").is_some() {
                    return Err("mcp: credential versions are assigned natively".into());
                }
                validate_server(&server)?;
                if servers.iter().any(|s| s["id"] == server["id"]) {
                    return Err("mcp: server already exists".into());
                }
                servers.push(server);
            }
            Change::Update {
                id,
                patches,
                expected,
                secrets,
            } => {
                let server = servers
                    .iter_mut()
                    .find(|s| s["id"] == id)
                    .ok_or("mcp: server was removed; reopen settings")?;
                stored_server_defaults(server)?;
                let credential_edit = !secrets.is_empty()
                    || patches
                        .iter()
                        .any(|p| p.path.first().is_some_and(|s| s == "transport"));
                if credential_edit || expected.is_some() {
                    super::credentials::check_expected(server, expected.as_ref())?;
                }
                patch(server, patches, false)?;
                if credential_edit {
                    server["secretsRevision"] = json!(server["secretsRevision"]
                        .as_u64()
                        .unwrap_or(0)
                        .checked_add(1)
                        .ok_or("mcp: credential revision exhausted")?);
                }
                validate_server(server)?;
            }
            Change::Delete { id } => servers.retain(|s| s["id"] != id),
            Change::Project {
                id,
                entry_hash,
                patches,
            } => {
                if !super::names::valid_server_id(&id)
                    || !id.starts_with("prj-")
                    || entry_hash.is_empty()
                    || entry_hash.len() > 128
                {
                    return Err("mcp: invalid project settings identity".into());
                }
                let record = records.entry(id).or_insert_with(|| json!({ "entryHash": entry_hash, "enabled": true, "trusted": false, "tools": {} }));
                supply_defaults(record, json!({"enabled":true,"trusted":false,"tools":{}}))?;
                if record["entryHash"] != entry_hash {
                    record["entryHash"] = json!(entry_hash);
                    record["trusted"] = json!(false);
                    if let Some(tools) = record["tools"].as_object_mut() {
                        tools.retain(|_, choice| choice == "deny");
                    }
                }
                patch(record, patches, true)?;
                if !record["enabled"].is_boolean()
                    || !record["trusted"].is_boolean()
                    || !valid_tools(&record["tools"])
                {
                    return Err("mcp: invalid project policy".into());
                }
            }
        }
    }
    let mut names = std::collections::HashSet::new();
    if servers
        .iter()
        .filter_map(|s| s["name"].as_str())
        .any(|name| !names.insert(name.trim().to_lowercase()))
    {
        return Err("mcp: another server has this name".into());
    }
    Ok(())
}

fn authorize(label: &str, changes: &[Change]) -> Result<(), String> {
    if label == super::SETTINGS_WINDOW
        || (crate::modules::windows::is_app_window(label)
            && changes.iter().all(|c| matches!(c, Change::Tools { .. })))
    {
        Ok(())
    } else {
        Err("mcp: configuration and credentials are saved in Settings".into())
    }
}

#[tauri::command]
pub async fn mcp_settings_mutate(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    changes: Value,
) -> Result<(), String> {
    if changes.to_string().len() > 1_048_576 {
        return Err("mcp: settings change is too large".into());
    }
    let changes: Vec<Change> = serde_json::from_value(changes).map_err(|e| e.to_string())?;
    authorize(window.label(), &changes)?;
    let state = app.state::<super::McpState>();
    let _guard = state.settings.lock().await;
    for change in &changes {
        if let Change::Project { id, entry_hash, .. } = change {
            if super::project::settings_entry_hash(&app, id).as_ref() != Some(entry_hash) {
                return Err(
                    "mcp: project server changed; reopen settings before editing its policy".into(),
                );
            }
        }
    }
    let store = store(&app)?;
    let old_servers = store.get("servers").unwrap_or(json!([]));
    let old_records = store.get("projectServers").unwrap_or(json!({}));
    let old: Vec<Value> = serde_json::from_value(old_servers.clone()).map_err(|e| e.to_string())?;
    let mut servers = old.clone();
    let mut records = serde_json::from_value(old_records.clone()).map_err(|e| e.to_string())?;
    apply(&mut servers, &mut records, changes.clone())?;
    let edits = changes
        .iter()
        .filter_map(|change| match change {
            Change::Create { server, secrets } => {
                Some((server["id"].as_str().unwrap().to_owned(), secrets.clone()))
            }
            Change::Update { id, secrets, .. } => Some((id.clone(), secrets.clone())),
            _ => None,
        })
        .collect();
    let plans = super::credentials::plan(&old, &mut servers, edits)?;
    // Serialize against refresh and sign-in preparation, but not the browser callback wait.
    let mut held = Vec::new();
    for plan in &plans {
        held.push(
            super::oauth::refresh_lock(&app, &plan.id)
                .lock_owned()
                .await,
        );
    }
    let mut snapshot = store.entries();
    snapshot.insert("servers".into(), json!(servers));
    snapshot.insert("projectServers".into(), json!(records));
    for change in &changes {
        if let Change::Tools { id, tools } = change {
            let key = format!("tools:{id}");
            if let Some(tools) = tools {
                snapshot.insert(key, tools.clone());
            } else {
                snapshot.remove(&key);
            }
        }
    }
    let publish_app = app.clone();
    super::credentials::commit(
        &super::credentials::NativeVault(app.clone()),
        &plans,
        || async {
            crate::modules::fs::blocking(move || {
                let servers = snapshot["servers"]
                    .as_array()
                    .expect("validated servers")
                    .clone();
                store.replace(snapshot)?;
                super::credentials::published(&publish_app, &servers);
                Ok(())
            })
            .await
        },
    )
    .await?;
    for change in &changes {
        match change {
            Change::Update { id, .. } | Change::Delete { id } | Change::Project { id, .. } => {
                super::oauth::cancel_probe_server(&app, id)
            }
            _ => (),
        }
    }
    for plan in &plans {
        super::oauth::configuration_changed(&app, &plan.id);
    }
    if changes.iter().any(|c| !matches!(c, Change::Tools { .. })) {
        let _ = app.emit("oarlock://mcp-changed", json!({"kind":"servers"}));
    } else {
        for change in changes {
            if let Change::Tools { id, .. } = change {
                let _ = app.emit(
                    "oarlock://mcp-changed",
                    json!({"kind":"tools","serverId":id}),
                );
            }
        }
    }
    Ok(())
}

pub(super) fn store(
    app: &tauri::AppHandle,
) -> Result<std::sync::Arc<super::storage::Store>, String> {
    let state = app.state::<super::McpState>();
    let mut saved = state.saved.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(saved) = &*saved {
        return Ok(saved.clone());
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(STORE);
    let opened = std::sync::Arc::new(super::storage::Store::open(path)?);
    *saved = Some(opened.clone());
    Ok(opened)
}

#[tauri::command]
pub async fn mcp_settings_snapshot(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    key: String,
) -> Result<Value, String> {
    authorize(window.label(), &[])?;
    if !matches!(key.as_str(), "servers" | "projectServers" | "tools")
        && !key
            .strip_prefix("tools:")
            .is_some_and(super::names::valid_server_id)
    {
        return Err("mcp: invalid snapshot key".into());
    }
    crate::modules::fs::blocking(move || {
        let store = store(&app)?;
        if key == "tools" {
            return Ok(Value::Object(
                store
                    .entries()
                    .into_iter()
                    .filter(|(k, _)| k.starts_with("tools:"))
                    .collect(),
            ));
        }
        Ok(store.get(&key).unwrap_or(Value::Null))
    })
    .await
}

pub(super) fn write_snapshot(
    path: &std::path::Path,
    snapshot: &serde_json::Map<String, Value>,
) -> Result<(), String> {
    write_snapshot_with(path, snapshot, |file| file.sync_all())
}

fn write_snapshot_with(
    path: &std::path::Path,
    snapshot: &serde_json::Map<String, Value>,
    sync: impl FnOnce(&std::fs::File) -> std::io::Result<()>,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(snapshot).map_err(|e| e.to_string())?;
    crate::modules::fs::native_store::write(path, &bytes, super::storage::MAX_BYTES, sync)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn server(id: &str) -> Value {
        json!({"id":id,"name":id,"source":"settings","enabled":true,"trusted":false,"transport":{"type":"stdio","command":"server","args":[],"env":[],"cwd":null},"tools":{},"secretsRevision":0})
    }
    fn change(value: Value) -> Change {
        serde_json::from_value(value).unwrap()
    }
    #[test]
    fn only_settings_can_edit_credentials_and_app_windows_can_record_tools() {
        let edits = vec![update("a", &["enabled"], json!(false))];
        let tools = vec![Change::Tools {
            id: "a".into(),
            tools: Some(json!([])),
        }];
        assert!(authorize("settings", &edits).is_ok());
        assert!(authorize("settings", &tools).is_ok());
        assert!(authorize("main", &tools).is_ok());
        assert!(authorize("main", &edits).is_err());
        assert!(authorize("untrusted", &tools).is_err());
    }
    #[test]
    fn a_failed_flush_keeps_the_previous_settings_file_and_removes_the_temporary() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("mcp.json");
        let before = json!({"servers":[server("a")]});
        let after = json!({"servers":[]});
        write_snapshot(&path, before.as_object().unwrap()).unwrap();
        let result = write_snapshot_with(&path, after.as_object().unwrap(), |_| {
            Err(std::io::Error::other("disk full"))
        });
        assert!(result.is_err());
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap(),
            before
        );
        assert_eq!(std::fs::read_dir(folder.path()).unwrap().count(), 1);
        write_snapshot(&path, after.as_object().unwrap()).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap(),
            after
        );
    }
    #[test]
    fn stale_authorization_header_cannot_be_attached_after_url_changes() {
        let mut initial = server("a");
        initial["transport"] =
            json!({"type":"http","url":"https://original.example/mcp","headers":[]});
        let expected = json!({"revision":0,"transport":initial["transport"]});
        let mut servers = vec![initial];
        let mut records = serde_json::Map::new();
        apply(&mut servers, &mut records, vec![change(json!({"kind":"update","id":"a","expected":expected,"patches":[{"path":["transport","url"],"value":"https://different.example/mcp"}]}))]).unwrap();
        let before = servers.clone();
        let stale = change(
            json!({"kind":"update","id":"a","expected":expected,"patches":[{"path":["transport","headers"],"value":[{"name":"Authorization","secret":true}]}],"secrets":[{"kind":"header","name":"Authorization","value":"private bearer"}]}),
        );
        assert!(apply(&mut servers, &mut records, vec![stale]).is_err());
        assert_eq!(servers, before);
    }
    #[test]
    fn existing_settings_with_omitted_optional_fields_remain_editable() {
        let mut servers = vec![
            json!({"id":"minimal","name":"Minimal","enabled":true,"transport":{"type":"stdio","command":"server"}}),
            json!({"id":"remote","name":"Remote","enabled":true,"transport":{"type":"http","url":"https://example.com","oauth":{"clientId":"client"}}}),
        ];
        apply(
            &mut servers,
            &mut serde_json::Map::new(),
            vec![
                update("minimal", &["enabled"], json!(false)),
                update("remote", &["enabled"], json!(false)),
            ],
        )
        .unwrap();
        assert_eq!(servers[0]["enabled"], false);
        assert_eq!(servers[0]["transport"]["args"], json!([]));
        assert_eq!(servers[0]["tools"], json!({}));
        assert_eq!(servers[0]["secretsRevision"], 0);
        assert_eq!(servers[1]["enabled"], false);
        assert_eq!(servers[1]["transport"]["headers"], json!([]));
        assert_eq!(servers[1]["transport"]["oauth"]["clientSecret"], false);
    }
    #[test]
    fn malformed_project_record_returns_an_error_without_poisoning_the_settings_lock() {
        let mut records = serde_json::Map::new();
        records.insert("prj-a".into(), json!("damaged"));
        let change = change(
            json!({"kind":"project","id":"prj-a","entryHash":"hash","patches":[{"path":["enabled"],"value":false}]}),
        );
        assert!(apply(&mut vec![], &mut records, vec![change]).is_err());
    }
    #[test]
    fn imported_optional_whitespace_matches_the_editors_transport_snapshot() {
        for (stored, displayed) in [
            (
                json!({"type":"stdio","command":"server","args":[],"env":[],"cwd":"  "}),
                json!({"type":"stdio","command":"server","args":[],"env":[],"cwd":null}),
            ),
            (
                json!({"type":"http","url":"https://example.com/mcp","headers":[],"oauth":{"clientId":" client ","clientSecret":false,"scopes":"   ","callbackPort":null}}),
                json!({"type":"http","url":"https://example.com/mcp","headers":[],"oauth":{"clientId":"client","clientSecret":false,"scopes":null,"callbackPort":null}}),
            ),
            (
                json!({"type":"sse","url":"https://example.com/mcp","headers":[],"oauth":{"clientId":"client","clientSecret":false,"scopes":" read write ","callbackPort":null}}),
                json!({"type":"sse","url":"https://example.com/mcp","headers":[],"oauth":{"clientId":"client","clientSecret":false,"scopes":"read write","callbackPort":null}}),
            ),
        ] {
            let mut initial = server("a");
            initial["transport"] = stored;
            let mut servers = vec![initial];
            let edit = change(
                json!({"kind":"update","id":"a","expected":{"revision":0,"transport":displayed},"patches":[{"path":["name"],"value":"Renamed"}]}),
            );
            apply(&mut servers, &mut serde_json::Map::new(), vec![edit]).unwrap();
            assert_eq!(servers[0]["name"], "Renamed");
            assert_eq!(servers[0]["secretsRevision"], 0);
        }
    }
    fn update(id: &str, path: &[&str], value: Value) -> Change {
        change(json!({"kind":"update","id":id,"patches":[{"path":path,"value":value}]}))
    }
    #[test]
    fn independent_servers_fields_and_tool_choices_survive_overlapping_edits() {
        let mut servers = vec![server("a"), server("b")];
        let mut records = serde_json::Map::new();
        for edit in [
            update("a", &["enabled"], json!(false)),
            update("b", &["trusted"], json!(true)),
            update("a", &["tools", "write"], json!("deny")),
            update("a", &["tools", "read"], json!("allow")),
            update("a", &["name"], json!("renamed")),
        ] {
            apply(&mut servers, &mut records, vec![edit]).unwrap();
        }
        assert_eq!(servers[0]["enabled"], false);
        assert_eq!(servers[1]["trusted"], true);
        assert_eq!(servers[0]["tools"], json!({"write":"deny","read":"allow"}));
        apply(
            &mut servers,
            &mut records,
            vec![update("a", &["tools", "read"], json!("deny"))],
        )
        .unwrap();
        assert_eq!(servers[0]["tools"]["read"], "deny");
    }
    #[test]
    fn project_updates_keep_other_servers_and_preserve_only_denials_across_hash_changes() {
        let mut servers = vec![];
        let mut records = serde_json::Map::new();
        for (id, hash, path, value) in [
            ("prj-a", "old", vec!["enabled"], json!(false)),
            ("prj-b", "old", vec!["trusted"], json!(true)),
            ("prj-a", "old", vec!["tools", "write"], json!("deny")),
            ("prj-a", "old", vec!["tools", "read"], json!("allow")),
            ("prj-a", "new", vec!["tools", "other"], json!("deny")),
        ] {
            apply(&mut servers, &mut records, vec![change(json!({"kind":"project","id":id,"entryHash":hash,"patches":[{"path":path,"value":value}]}))]).unwrap();
        }
        assert_eq!(records["prj-a"]["enabled"], false);
        assert_eq!(records["prj-b"]["trusted"], true);
        assert_eq!(
            records["prj-a"]["tools"],
            json!({"write":"deny","other":"deny"})
        );
        assert_eq!(records["prj-a"]["trusted"], false);
    }
    #[test]
    fn stale_update_cannot_resurrect_a_deleted_server() {
        let mut servers = vec![server("a")];
        let mut records = serde_json::Map::new();
        apply(
            &mut servers,
            &mut records,
            vec![Change::Delete { id: "a".into() }],
        )
        .unwrap();
        assert!(apply(
            &mut servers,
            &mut records,
            vec![update("a", &["enabled"], json!(true))]
        )
        .is_err());
        assert!(servers.is_empty());
    }
    #[test]
    fn transport_and_secret_edits_reject_stale_snapshots_but_policy_merges() {
        let mut servers = vec![server("a")];
        let mut records = serde_json::Map::new();
        let base = servers[0].clone();
        let edit = |path: &[&str], value: Value| {
            change(json!({"kind":"update","id":"a",
            "expected":{"transport":base["transport"],"revision":0},
            "patches":[{"path":path,"value":value}]}))
        };
        apply(
            &mut servers,
            &mut records,
            vec![edit(&["transport", "command"], json!("new-server"))],
        )
        .unwrap();
        assert_eq!(servers[0]["secretsRevision"], 1);
        assert!(apply(
            &mut servers,
            &mut records,
            vec![edit(&["transport", "env"], json!([]))]
        )
        .is_err());
        assert!(apply(
            &mut servers,
            &mut records,
            vec![change(json!({"kind":"update","id":"a",
            "expected":{"transport":base["transport"],"revision":0},"patches":[],
            "secrets":[{"kind":"env","name":"TOKEN","value":"old-endpoint-secret"}]}))]
        )
        .is_err());
        apply(
            &mut servers,
            &mut records,
            vec![update("a", &["enabled"], json!(false))],
        )
        .unwrap();
        assert_eq!(servers[0]["enabled"], false);
        assert!(apply(
            &mut servers,
            &mut records,
            vec![update("a", &["transport", "command"], json!("unversioned"))]
        )
        .is_err());
    }
    #[test]
    fn invalid_transactions_never_replace_the_persisted_snapshot() {
        let current = vec![server("a")];
        for edit in [
            update("a", &["id"], json!("b")),
            update("a", &["enabled"], json!("true")),
            update("a", &["transport", "command"], json!("bad\u{0000}")),
            update("a", &["tools", "x"], json!("unexpected")),
        ] {
            let mut next = current.clone();
            assert!(apply(&mut next, &mut serde_json::Map::new(), vec![edit]).is_err());
            assert_eq!(current[0], server("a"));
        }
    }
    #[test]
    fn creation_does_not_overwrite_existing_servers_or_duplicate_names() {
        let mut servers = vec![server("a")];
        assert!(apply(
            &mut servers,
            &mut serde_json::Map::new(),
            vec![Change::Create {
                server: server("a"),
                secrets: vec![]
            }]
        )
        .is_err());
        let mut duplicate = server("b");
        duplicate["name"] = json!("A");
        assert!(apply(
            &mut servers,
            &mut serde_json::Map::new(),
            vec![Change::Create {
                server: duplicate,
                secrets: vec![]
            }]
        )
        .is_err());
    }
}
