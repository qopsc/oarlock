//! Native MCP persistence. Never registers with the general-purpose store plugin,
//! whose exit hook rewrites loaded files. A failed load creates no writable cache.
use serde_json::{Map, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

pub(super) const MAX_BYTES: u64 = 64 * 1024 * 1024;
pub struct Store {
    path: PathBuf,
    contents: RwLock<Map<String, Value>>,
}
impl Store {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let contents = read(&path).map_err(|e| format!("MCP settings could not be read at {}. The file was preserved; repair it and retry. {e}", path.display()))?;
        Ok(Self {
            path,
            contents: RwLock::new(contents),
        })
    }
    pub fn get(&self, key: &str) -> Option<Value> {
        self.contents
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .cloned()
    }
    pub fn entries(&self) -> Map<String, Value> {
        self.contents
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    /// The caller holds the process-wide settings transaction lock.
    pub fn replace(&self, next: Map<String, Value>) -> Result<(), String> {
        super::settings::write_snapshot(&self.path, &next)?;
        *self.contents.write().unwrap_or_else(|e| e.into_inner()) = next;
        Ok(())
    }
}
fn read(path: &Path) -> Result<Map<String, Value>, String> {
    let file = match crate::modules::fs::open_store_file(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // A dangling symlink still names an existing file to preserve.
            if std::fs::symlink_metadata(path).is_ok() {
                return Err(e.to_string());
            }
            return Ok(Map::new());
        }
        Err(e) => return Err(e.to_string()),
    };
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("file exceeds 64 MiB".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("file exceeds 64 MiB".into());
    }
    let contents: Map<String, Value> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if contents.get("servers").is_some_and(|v| !v.is_array())
        || contents
            .get("projectServers")
            .is_some_and(|v| !v.is_object())
    {
        return Err("invalid MCP settings structure".into());
    }
    for (id, record) in contents
        .get("projectServers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        if !id.starts_with("prj-")
            || !super::names::valid_server_id(id)
            || !record.is_object()
            || !record["entryHash"]
                .as_str()
                .is_some_and(|hash| !hash.is_empty() && hash.len() <= 128)
            || record.get("enabled").is_some_and(|v| !v.is_boolean())
            || record.get("trusted").is_some_and(|v| !v.is_boolean())
            || record
                .get("tools")
                .is_some_and(|v| !super::settings::valid_tools(v))
        {
            return Err("invalid project MCP policy".into());
        }
    }
    let mut ids = std::collections::HashSet::new();
    for server in contents
        .get("servers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let mut normalized = server.clone();
        super::settings::stored_server_defaults(&mut normalized)?;
        super::settings::validate_server(&normalized)?;
        super::credentials::account_at(&normalized, String::new())?;
        if !ids.insert(normalized["id"].as_str().unwrap().to_owned()) {
            return Err("duplicate MCP server identity".into());
        }
    }
    Ok(contents)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn mcp_store_refuses_symlink_reads_and_writes() {
        use std::{fs, os::unix::fs::symlink};
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        let store = Store::open(path.clone()).unwrap();
        store.replace(Map::new()).unwrap();
        let outside = root.path().join("outside.json");
        fs::write(&outside, b"outside").unwrap();
        fs::remove_file(&path).unwrap();
        symlink(&outside, &path).unwrap();
        assert!(Store::open(path).is_err());
        assert!(store.replace(Map::new()).is_err());
        assert_eq!(fs::read(outside).unwrap(), b"outside");
    }
    use serde_json::json;
    #[test]
    fn damaged_or_wrongly_shaped_files_never_become_empty_writable_stores() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("mcp.json");
        for bytes in [
            "{bad json",
            "",
            "[]",
            "{\"servers\":{}}",
            "{\"projectServers\":[]}",
            "{\"servers\":[\"bad\"]}",
            r#"{"projectServers":{"prj-a":"bad"}}"#,
            r#"{"projectServers":{"prj-a":{"entryHash":"hash","enabled":"false"}}}"#,
            r#"{"projectServers":{"prj-a":{"entryHash":"hash","tools":{"read":"unexpected"}}}}"#,
        ] {
            std::fs::write(&path, bytes).unwrap();
            assert!(Store::open(path.clone()).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), bytes);
        }
        // A repaired file is readable on retry; failed loads leave no poisoned cache.
        std::fs::write(&path, "{\"servers\":[]}").unwrap();
        assert_eq!(Store::open(path).unwrap().get("servers"), Some(json!([])));
    }
    #[test]
    fn an_unreadable_path_is_not_treated_as_an_empty_store() {
        let folder = tempfile::tempdir().unwrap();
        assert!(Store::open(folder.path().to_owned()).is_err());
    }
    #[test]
    fn reads_and_shutdown_never_write_but_explicit_commits_preserve_other_fields() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("mcp.json");
        let store = Store::open(path.clone()).unwrap();
        assert!(!path.exists());
        let next = json!({"servers":[],"projectServers":{},"tools:a":[{"name":"read"}],"future":"preserved"}).as_object().unwrap().clone();
        store.replace(next.clone()).unwrap();
        assert_eq!(Store::open(path.clone()).unwrap().entries(), next);
        // Dropping the owner cannot overwrite a damaged or externally changed file on exit.
        std::fs::write(&path, "external changes").unwrap();
        drop(store);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "external changes");
    }
    #[test]
    fn failed_commit_keeps_the_previous_memory_snapshot() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("mcp.json");
        let store = Store::open(path.clone()).unwrap();
        // A directory cannot be replaced by the temporary file.
        std::fs::create_dir(&path).unwrap();
        assert!(store
            .replace(json!({"servers":[]}).as_object().unwrap().clone())
            .is_err());
        assert!(store.entries().is_empty());
        assert!(path.is_dir());
    }
    #[test]
    fn legacy_optional_fields_remain_readable_without_migration_writes() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("mcp.json");
        let text = r#"{"servers":[{"id":"a","name":"A","transport":{"type":"stdio","command":"server"}}]}"#;
        std::fs::write(&path, text).unwrap();
        Store::open(path.clone()).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
    }
}
