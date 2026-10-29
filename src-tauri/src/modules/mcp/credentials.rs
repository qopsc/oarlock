//! A configuration points at immutable keychain accounts. Failed staging or persistence
//! never overwrites the credentials used by the last saved configuration.
use super::names::{self, OauthItem, SecretKind, SECRET_SERVICE};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use tauri::{AppHandle, Manager};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Expected {
    pub transport: Value,
    pub revision: u64,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Write {
    pub kind: SecretKind,
    pub name: String,
    pub value: String,
}

pub fn check_expected(server: &Value, expected: Option<&Expected>) -> Result<(), String> {
    if expected
        .is_some_and(|e| e.transport == server["transport"] && e.revision == revision(server))
    {
        Ok(())
    } else {
        Err("mcp: transport or credentials changed; reopen the editor and review the current settings".into())
    }
}
fn revision(server: &Value) -> u64 {
    server["secretsRevision"].as_u64().unwrap_or(0)
}

pub fn server(app: &AppHandle, id: &str) -> Result<Value, String> {
    let mut value = super::settings::store(app)?
        .get("servers")
        .and_then(|v| v.as_array()?.iter().find(|v| v["id"] == id).cloned())
        .ok_or("mcp: server was removed; reopen settings")?;
    super::settings::stored_server_defaults(&mut value)?;
    Ok(value)
}

pub fn account_at(server: &Value, account: String) -> Result<String, String> {
    match server.get("credentialVersion") {
        None => Ok(account), // Existing installations and not-yet-imported credentials.
        Some(Value::String(version))
            if version.len() == 32 && version.bytes().all(|b| b.is_ascii_hexdigit()) =>
        {
            Ok(format!("{account}@{version}"))
        }
        _ => Err("mcp: invalid credential version".into()),
    }
}
#[derive(Clone)]
pub struct Version {
    revision: u64,
    namespace: Option<Value>,
}
fn versions(servers: &[Value]) -> std::collections::HashMap<String, Version> {
    servers
        .iter()
        .filter_map(|s| {
            Some((
                s["id"].as_str()?.to_owned(),
                Version {
                    revision: revision(s),
                    namespace: s.get("credentialVersion").cloned(),
                },
            ))
        })
        .collect()
}
fn current(app: &AppHandle, id: &str) -> Result<Version, String> {
    let state = app.state::<super::McpState>();
    {
        let cached = state.credentials.read().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = &*cached {
            return cached
                .get(id)
                .cloned()
                .ok_or("mcp: server was removed".into());
        }
    }
    let mut cached = state.credentials.write().unwrap_or_else(|e| e.into_inner());
    if cached.is_none() {
        let saved = super::settings::store(app)?
            .get("servers")
            .unwrap_or(json!([]));
        *cached = Some(versions(
            saved.as_array().ok_or("mcp: invalid server settings")?,
        ));
    }
    cached
        .as_ref()
        .and_then(|v| v.get(id))
        .cloned()
        .ok_or("mcp: server was removed".into())
}
// Only revision and namespace stay cached, never another copy of server configurations.
pub fn published(app: &AppHandle, servers: &[Value]) {
    let state = app.state::<super::McpState>();
    let mut cached = state.credentials.write().unwrap_or_else(|e| e.into_inner());
    if cached.is_some() {
        *cached = Some(versions(servers));
    }
}
pub fn check_revision(app: &AppHandle, id: &str, expected: u64) -> Result<(), String> {
    if current(app, id)?.revision == expected {
        Ok(())
    } else {
        Err("mcp: server configuration changed; reconnect with the current settings".into())
    }
}
pub fn account(app: &AppHandle, id: &str, account: String) -> Result<String, String> {
    if id.starts_with("prj-") {
        return Ok(account);
    }
    let version = current(app, id)?;
    match version.namespace {
        None => Ok(account),
        Some(namespace) => account_at(&json!({"credentialVersion":namespace}), account),
    }
}

/// Checked before reading any credentials for a delayed global launch.
pub fn launch(app: &AppHandle, id: &str, expected: u64) -> Result<Value, String> {
    let server = server(app, id)?;
    if revision(&server) != expected {
        return Err(
            "mcp: server configuration changed; reconnect with the current settings".into(),
        );
    }
    Ok(server)
}

fn refs(server: &Value) -> Result<Vec<String>, String> {
    let id = server["id"].as_str().ok_or("mcp: invalid server id")?;
    let transport = &server["transport"];
    let (kind, field) = if transport["type"] == "stdio" {
        (SecretKind::Env, "env")
    } else {
        (SecretKind::Header, "headers")
    };
    let mut refs = Vec::new();
    for entry in transport[field].as_array().into_iter().flatten() {
        if entry["secret"] == true {
            refs.push(names::secret_account(
                id,
                kind,
                entry["name"].as_str().ok_or("mcp: invalid secret name")?,
            )?);
        }
    }
    if transport["oauth"]["clientSecret"] == true {
        refs.push(names::secret_account(
            id,
            SecretKind::Oauth,
            names::OAUTH_CLIENT_SECRET,
        )?);
    }
    let mut seen = HashSet::new();
    if refs.iter().any(|r| !seen.insert(r.clone())) {
        return Err("mcp: duplicate secret name".into());
    }
    Ok(refs)
}

pub struct Plan {
    pub id: String,
    // destination, optional previous account, optional replacement value
    writes: Vec<(String, Option<String>, Option<String>)>,
    retire: Vec<String>,
}

pub fn plan(
    old: &[Value],
    next: &mut [Value],
    edits: Vec<(String, Vec<Write>)>,
) -> Result<Vec<Plan>, String> {
    let mut values = BTreeMap::new();
    for (id, writes) in edits {
        if values.insert(id, writes).is_some() {
            return Err("mcp: duplicate server edit".into());
        }
    }
    let mut plans = Vec::new();
    for after in next.iter_mut() {
        let id = after["id"]
            .as_str()
            .ok_or("mcp: invalid server id")?
            .to_owned();
        let before = old.iter().find(|s| s["id"] == id);
        if before.is_some_and(|s| revision(s) == revision(after)) {
            continue;
        }
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce)
            .map_err(|e| format!("mcp: could not create credential version: {e}"))?;
        after["credentialVersion"] =
            json!(nonce.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let wanted = refs(after)?;
        let mut replacements = BTreeMap::new();
        for write in values.remove(&id).unwrap_or_default() {
            let key = names::secret_account(&id, write.kind, &write.name)?;
            if write.value.is_empty()
                || !names::valid_value(&write.value, write.kind)
                || !wanted.contains(&key)
            {
                return Err("mcp: invalid or unreferenced credential".into());
            }
            if replacements.insert(key, write.value).is_some() {
                return Err("mcp: duplicate credential".into());
            }
        }
        let previous_refs = before
            .map(refs)
            .transpose()?
            .unwrap_or_else(|| wanted.clone());
        let mut writes = Vec::new();
        for key in wanted {
            let source = previous_refs
                .contains(&key)
                .then(|| account_at(before.unwrap_or(&Value::Null), key.clone()))
                .transpose()?;
            writes.push((
                account_at(after, key.clone())?,
                source,
                replacements.remove(&key),
            ));
        }
        let retire = retired(before.unwrap_or(&json!({"id":id,"transport":after["transport"]})))?;
        plans.push(Plan { id, writes, retire });
    }
    for before in old {
        if !next.iter().any(|s| s["id"] == before["id"]) {
            plans.push(Plan {
                id: before["id"].as_str().unwrap().to_owned(),
                writes: vec![],
                retire: retired(before)?,
            });
        }
    }
    // A stable order makes lock acquisition independent of caller ordering.
    plans.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(plans)
}
fn retired(server: &Value) -> Result<Vec<String>, String> {
    let id = server["id"].as_str().ok_or("mcp: invalid server id")?;
    let mut keys = refs(server)?;
    keys.push(names::oauth_account(id, OauthItem::Tokens)?);
    keys.push(names::oauth_account(id, OauthItem::Client)?);
    keys.into_iter().map(|k| account_at(server, k)).collect()
}

pub trait Vault {
    async fn get(&self, account: String) -> Result<Option<String>, String>;
    async fn set(&self, account: String, value: String) -> Result<(), String>;
    async fn delete(&self, accounts: Vec<String>) -> Result<(), String>;
}
pub struct NativeVault(pub AppHandle);
impl Vault for NativeVault {
    async fn get(&self, account: String) -> Result<Option<String>, String> {
        Ok(
            crate::modules::secrets::backend_get(self.0.clone(), SECRET_SERVICE, vec![account])
                .await?
                .pop()
                .flatten(),
        )
    }
    async fn set(&self, account: String, value: String) -> Result<(), String> {
        crate::modules::secrets::backend_set(self.0.clone(), SECRET_SERVICE, account, value).await
    }
    async fn delete(&self, accounts: Vec<String>) -> Result<(), String> {
        crate::modules::secrets::backend_delete(self.0.clone(), SECRET_SERVICE, accounts).await
    }
}

pub async fn commit<F: std::future::Future<Output = Result<(), String>>>(
    vault: &impl Vault,
    plans: &[Plan],
    persist: impl FnOnce() -> F,
) -> Result<(), String> {
    let mut staged = Vec::new();
    let result = async {
        for plan in plans {
            for (destination, source, replacement) in &plan.writes {
                let value = match replacement {
                    Some(value) => Some(value.clone()),
                    None => match source {
                        Some(source) => vault.get(source.clone()).await?,
                        None => None,
                    },
                };
                if let Some(value) = value {
                    // Include even a failed write: the keychain may have written some chunks.
                    staged.push(destination.clone());
                    vault.set(destination.clone(), value).await?;
                }
            }
        }
        persist().await
    }
    .await;
    let cleanup = if result.is_err() {
        staged
    } else {
        plans.iter().flat_map(|p| p.retire.clone()).collect()
    };
    if !cleanup.is_empty() {
        if let Err(error) = vault.delete(cleanup).await {
            log::warn!("mcp: could not remove unused credential accounts: {error}");
        }
    }
    result
}

#[derive(Deserialize)]
pub struct Entry {
    name: String,
    secret: bool,
    value: Option<String>,
}
pub fn entries(
    value: &Value,
) -> Result<(std::collections::HashMap<String, String>, Vec<String>), String> {
    let entries: Vec<Entry> = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    let mut plain = std::collections::HashMap::new();
    let mut secrets = Vec::new();
    for entry in entries {
        if entry.secret {
            secrets.push(entry.name);
        } else {
            plain.insert(entry.name, entry.value.ok_or("mcp: missing value")?);
        }
    }
    Ok((plain, secrets))
}

pub fn require_unconfigured(app: &AppHandle, id: &str) -> Result<(), String> {
    if id.starts_with("prj-") {
        return Err("mcp: project server identities are reserved".into());
    }
    let saved = super::settings::store(app)?
        .get("servers")
        .unwrap_or(json!([]));
    let servers = saved.as_array().ok_or("mcp: invalid server settings")?;
    if servers.iter().any(|s| s["id"] == id) {
        return Err("mcp: save credential changes with the server configuration".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    #[derive(Default)]
    struct FakeVault {
        values: Mutex<BTreeMap<String, String>>,
        fail_set: bool,
        fail_delete: bool,
    }
    impl Vault for FakeVault {
        async fn get(&self, key: String) -> Result<Option<String>, String> {
            Ok(self.values.lock().unwrap().get(&key).cloned())
        }
        async fn set(&self, key: String, value: String) -> Result<(), String> {
            self.values.lock().unwrap().insert(key, value);
            if self.fail_set {
                Err("write failed after partial staging".into())
            } else {
                Ok(())
            }
        }
        async fn delete(&self, keys: Vec<String>) -> Result<(), String> {
            if self.fail_delete {
                return Err("cleanup failed".into());
            }
            for key in keys {
                self.values.lock().unwrap().remove(&key);
            }
            Ok(())
        }
    }
    fn server() -> Value {
        json!({"id":"a","secretsRevision":0,"transport":{"type":"http","url":"https://old.example/mcp","headers":[{"name":"Authorization","secret":true}]}})
    }
    fn replacement() -> Write {
        Write {
            kind: SecretKind::Header,
            name: "Authorization".into(),
            value: "new secret".into(),
        }
    }
    fn existing(fail_set: bool, fail_delete: bool) -> FakeVault {
        FakeVault {
            values: Mutex::new(BTreeMap::from([
                ("a/header/authorization".into(), "old secret".into()),
                ("a/oauth/tokens".into(), "old tokens".into()),
            ])),
            fail_set,
            fail_delete,
        }
    }
    fn edit() -> Value {
        let mut next = server();
        next["secretsRevision"] = json!(1);
        next
    }
    #[test]
    fn credential_namespaces_cannot_alias_legacy_accounts_or_chunk_suffixes() {
        let legacy = "a/header/authorization";
        assert_eq!(account_at(&json!({}), legacy.into()).unwrap(), legacy);
        let versioned = json!({"credentialVersion":"0123456789abcdef0123456789abcdef"});
        let key = account_at(&versioned, legacy.into()).unwrap();
        assert_ne!(key, legacy);
        assert!(!crate::modules::secrets::is_chunk_account(&key));
        for value in [
            Value::Null,
            json!(""),
            json!("../other"),
            json!("0123456789abcdef0123456789abcde:1"),
        ] {
            assert!(account_at(&json!({"credentialVersion":value}), legacy.into()).is_err());
        }
    }
    #[tokio::test]
    async fn failed_staging_preserves_every_active_credential_and_never_publishes() {
        let vault = existing(true, false);
        let original = vault.values.lock().unwrap().clone();
        let plans = plan(
            &[server()],
            &mut [edit()],
            vec![("a".into(), vec![replacement()])],
        )
        .unwrap();
        assert!(
            commit(&vault, &plans, || async { panic!("must not persist") })
                .await
                .is_err()
        );
        assert_eq!(*vault.values.lock().unwrap(), original);
    }
    #[tokio::test]
    async fn failed_persistence_preserves_old_secrets_and_oauth_even_when_cleanup_fails() {
        for fail_delete in [false, true] {
            let vault = existing(false, fail_delete);
            let mut next = [edit()];
            let plans = plan(
                &[server()],
                &mut next,
                vec![("a".into(), vec![replacement()])],
            )
            .unwrap();
            assert!(commit(&vault, &plans, || async { Err("disk full".into()) })
                .await
                .is_err());
            let values = vault.values.lock().unwrap();
            assert_eq!(values["a/header/authorization"], "old secret");
            assert_eq!(values["a/oauth/tokens"], "old tokens");
            assert_eq!(values.len(), if fail_delete { 3 } else { 2 });
            assert_ne!(
                account_at(&server(), "a/header/authorization".into()).unwrap(),
                account_at(&next[0], "a/header/authorization".into()).unwrap()
            );
        }
    }
    #[tokio::test]
    async fn successful_commit_publishes_staged_values_before_retiring_old_accounts() {
        let vault = existing(false, false);
        let mut next = [edit()];
        let plans = plan(
            &[server()],
            &mut next,
            vec![("a".into(), vec![replacement()])],
        )
        .unwrap();
        let new_key = account_at(&next[0], "a/header/authorization".into()).unwrap();
        commit(&vault, &plans, || async {
            let values = vault.values.lock().unwrap();
            assert_eq!(values[&new_key], "new secret");
            assert_eq!(values["a/header/authorization"], "old secret");
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(
            *vault.values.lock().unwrap(),
            BTreeMap::from([(new_key, "new secret".into())])
        );
    }
    #[tokio::test]
    async fn failed_deletion_keeps_credentials_and_retry_can_remove_them() {
        let vault = existing(false, false);
        let original = vault.values.lock().unwrap().clone();
        let plans = plan(&[server()], &mut [], vec![]).unwrap();
        assert!(
            commit(&vault, &plans, || async { Err("save failed".into()) })
                .await
                .is_err()
        );
        assert_eq!(*vault.values.lock().unwrap(), original);
        commit(&vault, &plans, || async { Ok(()) }).await.unwrap();
        assert!(vault.values.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn transport_edit_copies_unchanged_secrets_without_reusing_oauth() {
        let vault = existing(false, false);
        let mut next = [edit()];
        next[0]["transport"]["url"] = json!("https://new.example/mcp");
        let plans = plan(&[server()], &mut next, vec![("a".into(), vec![])]).unwrap();
        commit(&vault, &plans, || async { Ok(()) }).await.unwrap();
        let values = vault.values.lock().unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(
            values[&account_at(&next[0], "a/header/authorization".into()).unwrap()],
            "old secret"
        );
        assert!(!values.contains_key(&account_at(&next[0], "a/oauth/tokens".into()).unwrap()));
    }
    #[test]
    fn invalid_secret_and_duplicate_edits_are_rejected_before_staging() {
        let mut invalid = replacement();
        invalid.value = "unsafe\r\nheader".into();
        assert!(plan(
            &[server()],
            &mut [edit()],
            vec![("a".into(), vec![invalid])]
        )
        .is_err());
        let mut unreferenced = replacement();
        unreferenced.name = "X-Other".into();
        assert!(plan(
            &[server()],
            &mut [edit()],
            vec![("a".into(), vec![unreferenced])]
        )
        .is_err());
        assert!(plan(
            &[server()],
            &mut [edit()],
            vec![("a".into(), vec![replacement(), replacement()])]
        )
        .is_err());
        assert!(plan(
            &[server()],
            &mut [edit()],
            vec![("a".into(), vec![]), ("a".into(), vec![])]
        )
        .is_err());
    }
    #[test]
    fn secret_only_changes_invalidate_stale_editors_and_policy_does_not_rekey() {
        let old = server();
        let updated = edit();
        assert!(check_expected(
            &updated,
            Some(&Expected {
                transport: old["transport"].clone(),
                revision: 0
            })
        )
        .is_err());
        let mut next = old.clone();
        next["enabled"] = json!(false);
        assert!(plan(&[old], &mut [next], vec![("a".into(), vec![])])
            .unwrap()
            .is_empty());
    }
}
