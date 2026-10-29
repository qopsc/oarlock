//! Retire only the exact global fish snippet Oarlock used to install. Keep a
//! non-autoloaded backup; edited files and symlinks belong to the user.
use std::path::Path;
const LEGACY: &str = include_str!("scripts/init.legacy.fish");

pub(super) fn retire(path: &Path) -> Result<(), String> {
    retire_with(path, || {})
}

fn retire_with(path: &Path, before_move: impl FnOnce()) -> Result<(), String> {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    if !metadata.is_file() || std::fs::read(path).ok().as_deref() != Some(LEGACY.as_bytes()) {
        return Ok(());
    }
    let parent = path.parent().ok_or("fish: missing config directory")?;
    let reserved = tempfile::Builder::new()
        .prefix("oarlock-backup-")
        .suffix(".disabled")
        .tempfile_in(parent)
        .map_err(|e| e.to_string())?;
    // Disarm cleanup before moving any content into this path. A crash or error
    // after the rename must leave the user's original bytes recoverable.
    let backup = reserved
        .into_temp_path()
        .keep()
        .map_err(|e| e.to_string())?;
    before_move();
    if let Err(error) = std::fs::rename(path, &backup) {
        let _ = std::fs::remove_file(&backup);
        // Another startup (possibly the other app profile) may have retired
        // the source after we inspected it. Its absence is already success.
        if error.kind() == std::io::ErrorKind::NotFound
            && !path.try_exists().map_err(|e| e.to_string())?
        {
            return Ok(());
        }
        return Err(error.to_string());
    }
    if !std::fs::symlink_metadata(&backup).is_ok_and(|m| m.is_file())
        || std::fs::read(&backup).ok().as_deref() != Some(LEGACY.as_bytes())
    {
        // Someone edited/replaced it between inspection and rename. Restore
        // without overwriting a concurrently created replacement.
        if std::fs::hard_link(&backup, path).is_ok() {
            let _ = std::fs::remove_file(&backup);
        } else {
            return Err(format!(
                "fish config changed during migration; preserved at {}",
                backup.display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parallel_startups_can_finish_the_same_legacy_migration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oarlock.fish");
        std::fs::write(&path, LEGACY).unwrap();
        retire_with(&path, || retire(&path).unwrap()).unwrap();
        assert!(!path.exists());
        let backups = std::fs::read_dir(dir.path()).unwrap().collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            std::fs::read_to_string(backups[0].as_ref().unwrap().path()).unwrap(),
            LEGACY
        );
    }

    #[test]
    fn only_the_generated_global_snippet_is_retired_and_its_bytes_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oarlock.fish");
        std::fs::write(&path, "user edits").unwrap();
        retire(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "user edits");
        std::fs::write(&path, LEGACY).unwrap();
        retire(&path).unwrap();
        assert!(!path.exists());
        let backup = std::fs::read_dir(dir.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(backup.extension().unwrap(), "disabled");
        assert_eq!(std::fs::read_to_string(backup).unwrap(), LEGACY);
        retire(&path).unwrap();
    }
    #[test]
    fn an_edit_during_migration_is_restored_instead_of_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oarlock.fish");
        std::fs::write(&path, LEGACY).unwrap();
        retire_with(&path, || {
            std::fs::write(&path, "edited during launch").unwrap();
        })
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "edited during launch"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[cfg(unix)]
    #[test]
    fn user_symlinks_are_never_migrated() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("user-script");
        let path = dir.path().join("oarlock.fish");
        std::fs::write(&target, LEGACY).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        retire(&path).unwrap();
        assert!(std::fs::symlink_metadata(path).unwrap().is_symlink());
        assert_eq!(std::fs::read_to_string(target).unwrap(), LEGACY);
    }
}
