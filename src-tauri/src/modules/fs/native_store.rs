//! Protect native-owned store identities from workspace write commands.
use std::{fs, io, path::{Path, PathBuf}};
use tauri::Manager;

pub(crate) fn write(
    path: &Path,
    bytes: &[u8],
    limit: u64,
    after_staging: impl FnOnce(&fs::File) -> io::Result<()>,
) -> Result<(), String> {
    write_with_policy(path, bytes, limit, after_staging, false)
}

pub(crate) fn write_private(
    path: &Path,
    bytes: &[u8],
    limit: u64,
    after_staging: impl FnOnce(&fs::File) -> io::Result<()>,
) -> Result<(), String> {
    write_with_policy(path, bytes, limit, after_staging, true)
}

fn write_with_policy(
    path: &Path,
    bytes: &[u8],
    limit: u64,
    after_staging: impl FnOnce(&fs::File) -> io::Result<()>,
    private: bool,
) -> Result<(), String> {
    use super::document_save::{self, SaveError};
    use std::io::Read;
    let parent = path.parent().ok_or("Store has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let target = super::store_target(path).map_err(|e| e.to_string())?;
    document_save::with_lock(&target, || {
        let version = match super::open_store_file(path) {
            Ok(mut file) => {
                let mut previous = Vec::new();
                (&mut file).take(limit.saturating_add(1)).read_to_end(&mut previous).map_err(|e| e.to_string())?;
                if previous.len() as u64 > limit { return Err("Store exceeds its size limit".into()); }
                Some(document_save::version(&file, &previous).map_err(|e| e.to_string())?)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound
                && fs::symlink_metadata(path).is_err_and(|e| e.kind() == io::ErrorKind::NotFound) => None,
            Err(error) => return Err(format!("Cannot safely open store: {error}")),
        };
        let validate = |actual: &Path| {
            if actual == target && super::store_target(path).is_ok_and(|current| current == target) {
                Ok(())
            } else { Err("Store directory changed".into()) }
        };
        let result = if private {
            document_save::write_checked_private(&target, bytes, version.as_deref(), validate, limit, after_staging)
        } else {
            document_save::write_checked_with_hook(&target, bytes, version.as_deref(), validate, limit, after_staging)
        };
        result.map(|_| ()).map_err(|error| match error {
            SaveError::Failed(message) => message,
            SaveError::Conflict(_) => "Store changed during commit; file preserved".into(),
        })
    })
}

const NATIVE_FILES: &[&str] = &[
    "oarlock-preferences.json", "oarlock-settings.json", "oarlock-themes.json",
    "oarlock-custom-themes.json", "oarlock-endpoints.json", "oarlock-mcp.json",
    "project-trust.json", "oarlock-windows.json", "oarlock-spaces.json", "skills-state.json",
    "oarlock-ai-sessions.json", "oarlock-ai-snippets.json", "oarlock-ai-todos.json",
    "oarlock-ai-agents.json", "oarlock-subagents.json",
];

pub(crate) fn refuse_write(app: &tauri::AppHandle, target: &Path) -> Result<(), String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut stores: Vec<PathBuf> = NATIVE_FILES.iter().map(|name| data.join(name)).collect();
    stores.push(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("secrets.json"));
    stores.push(app.path().app_config_dir().map_err(|e| e.to_string())?.join(".window-state.json"));
    stores.extend(crate::modules::agent::protected_settings_paths()?);
    check(target, &stores)?;
    check_trees(target, &[
        data.join("windows"), data.join("terminal-scrollback"),
        data.join("conversations"), data.join(".oarlock-window-restore"),
    ])
}

#[cfg(unix)]
fn check_trees(target: &Path, roots: &[PathBuf]) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = match fs::metadata(target) {
        Ok(meta) => Some(meta),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Cannot verify native-store target: {error}")),
    };
    let resolved = fs::canonicalize(target).ok().or_else(|| normalized(target).ok());
    for root in roots {
        let actual = fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        if target.starts_with(root) || resolved.as_ref().is_some_and(|path| path.starts_with(&actual))
            || metadata.as_ref().is_some_and(|meta| meta.is_dir())
                && resolved.as_ref().is_some_and(|path| actual.starts_with(path)) {
            return Err("Cannot modify native-owned application data from the workspace".into());
        }
    }
    let Some(meta) = metadata.filter(|meta| meta.is_file() && meta.nlink() > 1) else { return Ok(()); };
    let wanted = (meta.dev(), meta.ino());
    let mut pending: Vec<PathBuf> = roots.to_vec();
    let mut visited = 0usize;
    while let Some(directory) = pending.pop() {
        match fs::symlink_metadata(&directory) {
            Ok(meta) if meta.is_dir() => {},
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Ok(_) => return Err("Native-store directory is not a plain directory".into()),
            Err(error) => return Err(format!("Cannot verify native-store directory: {error}")),
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Cannot verify native-store identities: {error}")),
        };
        for entry in entries {
            visited += 1;
            if visited > 32_768 { return Err("Too many native-store entries to verify safely".into()); }
            let entry = entry.map_err(|e| e.to_string())?;
            let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if meta.is_dir() { pending.push(entry.path()); }
            else if meta.is_file() && (meta.dev(), meta.ino()) == wanted {
                return Err("Cannot modify an alias of native-owned application data".into());
            }
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_trees(_: &Path, _: &[PathBuf]) -> Result<(), String> {
    Err("Native-store identity checks are unavailable on this platform".into())
}

fn normalized(path: &Path) -> io::Result<PathBuf> {
    let parent = path.parent().ok_or_else(|| io::Error::other("File has no parent"))?;
    let name = path.file_name().ok_or_else(|| io::Error::other("File has no name"))?;
    Ok(fs::canonicalize(parent)?.join(name))
}

fn check(target: &Path, stores: &[PathBuf]) -> Result<(), String> {
    let target_meta = match fs::metadata(target) {
        Ok(meta) => Some(meta),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("Cannot verify store identity: {e}")),
    };
    let target_name = normalized(target).ok();
    let target_dir = target_meta.as_ref().filter(|m| m.is_dir()).and_then(|_| fs::canonicalize(target).ok());
    for store in stores {
        if target == store || target_name.is_some() && target_name == normalized(store).ok() {
            return Err("Cannot modify a native-owned settings file from the workspace".into());
        }
        if target_dir.as_ref().is_some_and(|dir| normalized(store).is_ok_and(|path| path.starts_with(dir))) {
            return Err("Cannot modify a folder containing a native-owned settings file".into());
        }
        let meta = match fs::metadata(store) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("Cannot verify native store identity: {e}")),
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if target_meta.as_ref().is_some_and(|target| target.dev() == meta.dev() && target.ino() == meta.ino()) {
                return Err("Cannot modify an alias of a native-owned settings file".into());
            }
        }
        #[cfg(not(unix))]
        if target_meta.is_some() {
            return Err("Native store identity checks are unavailable on this platform".into());
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn refuses_store_and_both_alias_types_but_allows_other_files() {
        let root = tempfile::tempdir().unwrap();
        let store = root.path().join("settings.json");
        let link = root.path().join("link");
        let hard = root.path().join("hard");
        let ordinary = root.path().join("ordinary");
        fs::write(&store, b"keep").unwrap();
        fs::write(&ordinary, b"ok").unwrap();
        symlink(&store, &link).unwrap();
        fs::hard_link(&store, &hard).unwrap();
        for target in [&store, &link, &hard] { assert!(check(target, std::slice::from_ref(&store)).is_err()); }
        assert!(check(&ordinary, &[store]).is_ok());
    }

    #[test]
    fn refuses_a_folder_containing_a_store_and_its_missing_destination() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("settings");
        fs::create_dir(&folder).unwrap();
        let store = folder.join("store.json");
        assert!(check(&folder, std::slice::from_ref(&store)).is_err());
        assert!(check(&store, std::slice::from_ref(&store)).is_err());
    }

    #[test]
    fn conditional_writer_accepts_the_callers_own_size_limit() {
        use super::super::document_save::{self, SaveError};
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        let first = document_save::write_checked_with_limit(&path, b"123456", None, |_| Ok(()), 6).unwrap();
        assert!(matches!(document_save::write_checked_with_limit(&path, b"1234567", Some(&first), |_| Ok(()), 6), Err(SaveError::Failed(_))));
        assert_eq!(fs::read(path).unwrap(), b"123456");
    }

    #[test]
    fn protects_nested_store_files_and_hardlink_aliases() {
        let root = tempfile::tempdir().unwrap();
        let store_dir = root.path().join("windows");
        fs::create_dir_all(store_dir.join("w-1")).unwrap();
        let store = store_dir.join("w-1/spaces.json");
        let alias = root.path().join("alias.json");
        let ordinary = root.path().join("ordinary.json");
        fs::write(&store, b"keep").unwrap();
        fs::hard_link(&store, &alias).unwrap();
        fs::write(&ordinary, b"ok").unwrap();
        for target in [&store, &alias, &store_dir] {
            assert!(check_trees(target, std::slice::from_ref(&store_dir)).is_err());
        }
        assert!(check_trees(&ordinary, &[store_dir]).is_ok());
    }
}
