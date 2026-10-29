//! Linux secret-file persistence; exercised on Unix hosts too.
use std::collections::HashMap;
use std::fs;

pub(crate) fn read_store_at(path: &std::path::Path) -> Result<HashMap<String, String>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && fs::symlink_metadata(path)
                    .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(HashMap::new())
        }
        Err(error) => return Err(error.to_string()),
    };
    serde_json::from_slice::<HashMap<String, String>>(&bytes).map_err(|e| e.to_string())
}

pub(crate) fn write_store_at(
    path: &std::path::Path,
    map: &HashMap<String, String>,
) -> Result<(), String> {
    write_with(path, map, |file| file.sync_all())
}

fn write_with(
    path: &std::path::Path,
    map: &HashMap<String, String>,
    sync: impl FnOnce(&fs::File) -> std::io::Result<()>,
) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    // Create exclusively in the same directory; never reopen a predictable name
    // whose permissions or symlink target could survive an earlier failed write.
    let parent = path.parent().ok_or("secrets: missing store directory")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut temp, map).map_err(|e| e.to_string())?;
    temp.flush().map_err(|e| e.to_string())?;
    sync(temp.as_file()).map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

    #[test]
    fn a_leftover_permissive_temp_file_cannot_expose_saved_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        let old_temp = path.with_extension("json.tmp");
        fs::write(&old_temp, "unrelated leftover").unwrap();
        fs::set_permissions(&old_temp, fs::Permissions::from_mode(0o644)).unwrap();
        write_store_at(&path, &HashMap::from([("key".into(), "secret".into())])).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert_eq!(fs::read_to_string(old_temp).unwrap(), "unrelated leftover");
    }

    #[test]
    fn a_predictable_temp_symlink_never_redirects_the_secret_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        let other = dir.path().join("other-file");
        fs::write(&other, "untouched").unwrap();
        symlink(&other, path.with_extension("json.tmp")).unwrap();
        write_store_at(&path, &HashMap::new()).unwrap();
        assert_eq!(fs::read_to_string(other).unwrap(), "untouched");
        assert!(!fs::symlink_metadata(path).unwrap().is_symlink());
    }

    #[test]
    fn only_a_missing_file_is_an_empty_secret_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        assert!(read_store_at(&path).unwrap().is_empty());
        symlink(dir.path().join("missing-target"), &path).unwrap();
        assert!(read_store_at(&path).is_err());
        fs::remove_file(&path).unwrap();
        fs::write(&path, "not json").unwrap();
        assert!(read_store_at(&path).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "not json");
    }

    #[test]
    fn failed_sync_preserves_previous_secrets_and_removes_staging() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        let old = HashMap::from([("key".into(), "previous".into())]);
        write_store_at(&path, &old).unwrap();
        let result = write_with(&path, &HashMap::new(), |_| {
            Err(std::io::Error::other("disk full"))
        });
        assert!(result.is_err());
        assert_eq!(read_store_at(&path).unwrap(), old);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
