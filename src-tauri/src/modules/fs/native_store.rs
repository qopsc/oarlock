//! Protect native-owned store identities from workspace write commands.
use std::{fs, io, path::{Path, PathBuf}};
use tauri::Manager;

const NATIVE_FILES: &[&str] = &[
    "oarlock-preferences.json", "oarlock-settings.json", "oarlock-themes.json",
    "oarlock-custom-themes.json", "oarlock-endpoints.json", "oarlock-mcp.json",
    "project-trust.json",
];

pub(crate) fn refuse_write(app: &tauri::AppHandle, target: &Path) -> Result<(), String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut stores: Vec<PathBuf> = NATIVE_FILES.iter().map(|name| data.join(name)).collect();
    stores.extend(crate::modules::agent::protected_settings_paths()?);
    check(target, &stores)
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
}
