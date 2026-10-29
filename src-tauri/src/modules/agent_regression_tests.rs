    use super::*;
    #[cfg(unix)]
    #[test]
    fn old_staging_symlink_cannot_modify_victim() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let victim = dir.path().join("victim");
        std::fs::write(&victim, "private").unwrap();
        symlink(&victim, path.with_extension("oarlock-tmp")).unwrap();
        write_atomic(&path, "safe").unwrap();
        assert_eq!(std::fs::read_to_string(victim).unwrap(), "private");
        assert_eq!(std::fs::read_to_string(path).unwrap(), "safe");
    }
    #[cfg(unix)]
    #[test]
    fn existing_settings_are_updated_without_losing_user_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let old = r#"{"permissions":{"allow":["keep"]}}"#;
        std::fs::write(&path, old).unwrap();
        enable_hooks_at(&path, find("claude").unwrap()).unwrap();
        let updated: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(updated["permissions"]["allow"][0], "keep");
        assert!(updated["hooks"]["Notification"].is_array());
    }
    #[cfg(unix)]
    #[test]
    fn settings_symlink_is_preserved_while_target_is_updated() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let target = dir.path().join("real.json");
        std::fs::write(&target, "{}").unwrap();
        symlink(&target, &path).unwrap();
        enable_hooks_at(&path, find("claude").unwrap()).unwrap();
        assert!(std::fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
        let updated: Value = serde_json::from_str(&std::fs::read_to_string(target).unwrap()).unwrap();
        assert!(updated["hooks"]["Notification"].is_array());
    }
    #[test]
    fn simultaneous_new_file_publications_have_one_winner() {
        use std::sync::{Arc, Barrier};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = ["one", "two"].into_iter().map(|data| {
            let path = path.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || { barrier.wait(); write_atomic(&path, data) })
        }).collect();
        let results: Vec<_> = workers.into_iter().map(|worker| worker.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(["one", "two"].contains(&std::fs::read_to_string(path).unwrap().as_str()));
    }
    #[test]
    fn unsupported_json_shape_preserves_original_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let old = r#"{"hooks":{"Notification":{"custom":"keep"}}}"#;
        std::fs::write(&path, old).unwrap();
        assert!(enable_hooks_at(&path, find("claude").unwrap()).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), old);
    }


#[cfg(unix)]
#[test]
fn uncooperative_external_writer_is_not_overwritten() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, "original").unwrap();
    // An external process does not acquire Oarlock's in-process lock.
    super::super::fs::document_save::with_lock(&path, || {
        let status = Command::new("/bin/sh")
            .args(["-c", "printf %s external > \"$1\"", "external-writer"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(status.success());
    });
    assert!(write_atomic(&path, "ours").is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "external");
}

#[cfg(unix)]
#[test]
fn existing_hardlinked_settings_are_refused_without_modifying_either_name() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    let path = dir.path().join("settings.json");
    std::fs::write(&target, "original").unwrap();
    std::fs::hard_link(&target, &path).unwrap();
    assert!(write_atomic(&path, "ours").is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "original");
}

#[test]
fn external_write_during_merge_causes_conflict_and_preserves_their_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, "original").unwrap();
    let result = agent_settings::edit(&path, |contents| {
        assert_eq!(contents, Some("original"));
        std::fs::write(&path, "external").unwrap();
        Ok(Some("ours".into()))
    });
    assert!(result.is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "external");
}

#[test]
fn identical_content_replacement_during_merge_causes_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, "original").unwrap();
    let result = agent_settings::edit(&path, |contents| {
        assert_eq!(contents, Some("original"));
        let replacement = dir.path().join("replacement");
        std::fs::write(&replacement, "original").unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        Ok(Some("ours".into()))
    });
    assert!(result.is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "original");
}

#[cfg(unix)]
#[test]
fn retargeting_settings_symlink_during_merge_is_refused() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    std::fs::write(&a, "original").unwrap();
    std::fs::write(&b, "other").unwrap();
    symlink(&a, &path).unwrap();
    let result = agent_settings::edit(&path, |_| {
        std::fs::remove_file(&path).unwrap();
        symlink(&b, &path).unwrap();
        Ok(Some("ours".into()))
    });
    assert!(result.is_err());
    assert_eq!(std::fs::read_to_string(a).unwrap(), "original");
    assert_eq!(std::fs::read_to_string(b).unwrap(), "other");
}

#[cfg(unix)]
#[test]
fn retargeting_parent_symlink_during_merge_is_refused() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    let link = dir.path().join("link");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    std::fs::write(a.join("settings"), "original").unwrap();
    std::fs::write(b.join("settings"), "other").unwrap();
    symlink(&a, &link).unwrap();
    let result = agent_settings::edit(&link.join("settings"), |_| {
        std::fs::remove_file(&link).unwrap();
        symlink(&b, &link).unwrap();
        Ok(Some("ours".into()))
    });
    assert!(result.is_err());
    assert_eq!(std::fs::read_to_string(a.join("settings")).unwrap(), "original");
    assert_eq!(std::fs::read_to_string(b.join("settings")).unwrap(), "other");
}

#[cfg(unix)]
#[test]
fn simultaneous_enables_preserve_settings_and_are_idempotent() {
    use std::sync::{Arc, Barrier};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, r#"{"permissions":{"allow":["keep"]}}"#).unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let workers: Vec<_> = (0..2).map(|_| {
        let path = path.clone(); let barrier = barrier.clone();
        std::thread::spawn(move || { barrier.wait(); enable_hooks_at(&path, find("claude").unwrap()) })
    }).collect();
    for worker in workers { worker.join().unwrap().unwrap(); }
    let updated: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(updated["permissions"]["allow"][0], "keep");
    assert_eq!(updated["hooks"]["Notification"].as_array().unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn production_update_never_uses_old_staging_symlink() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let victim = dir.path().join("victim");
    std::fs::write(&path, "{}").unwrap();
    std::fs::write(&victim, "private").unwrap();
    symlink(&victim, path.with_extension("oarlock-tmp")).unwrap();
    enable_hooks_at(&path, find("claude").unwrap()).unwrap();
    assert_eq!(std::fs::read_to_string(victim).unwrap(), "private");
    let updated: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(updated["hooks"]["Notification"].is_array());
}

#[cfg(unix)]
#[test]
fn production_update_preserves_other_hardlink_contents() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("original");
    let path = dir.path().join("settings.json");
    std::fs::write(&target, "{}").unwrap();
    std::fs::hard_link(&target, &path).unwrap();
    enable_hooks_at(&path, find("claude").unwrap()).unwrap();
    assert_eq!(std::fs::read_to_string(target).unwrap(), "{}");
    let updated: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert!(updated["hooks"]["Notification"].is_array());
}

#[cfg(unix)]
#[test]
fn replacing_symlink_with_another_link_to_the_same_target_is_refused() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let old_link = dir.path().join("previous-link");
    let target = dir.path().join("target");
    std::fs::write(&target, "original").unwrap();
    symlink(&target, &path).unwrap();
    let result = agent_settings::edit(&path, |_| {
        std::fs::rename(&path, &old_link).unwrap();
        symlink(&target, &path).unwrap();
        Ok(Some("ours".into()))
    });
    assert!(result.is_err());
    assert_eq!(std::fs::read_to_string(target).unwrap(), "original");
}

#[cfg(target_os = "macos")]
#[test]
fn production_update_preserves_quarantine_metadata() {
    use std::os::fd::AsRawFd;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, "{}").unwrap();
    let old = std::fs::File::open(&path).unwrap();
    let attribute = c"com.apple.quarantine";
    let value = b"0083;00000000;OarlockReview;";
    assert_eq!(unsafe { libc::fsetxattr(old.as_raw_fd(), attribute.as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) }, 0);
    enable_hooks_at(&path, find("claude").unwrap()).unwrap();
    let updated = std::fs::File::open(&path).unwrap();
    let mut bytes = [0u8; 256];
    let count = unsafe { libc::fgetxattr(updated.as_raw_fd(), attribute.as_ptr(), bytes.as_mut_ptr().cast(), bytes.len(), 0, 0) };
    assert!(count >= 0);
    assert_eq!(&bytes[..count as usize], value);
}

#[cfg(windows)]
#[test]
fn unsupported_windows_update_fails_without_changing_settings() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let original = r#"{"permissions":{"allow":["keep"]}}"#;
    std::fs::write(&path, original).unwrap();
    assert!(enable_hooks_at(&path, find("claude").unwrap()).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), original);
}
