#![cfg(any(target_os = "macos", target_os = "linux"))]
use super::*;

fn put(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}
fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    put(
        &root.join("windows/w-a/oarlock-spaces.json"),
        "saved spaces",
    );
    put(
        &root.join("windows/w-a/terminal-scrollback/sb-1.vt"),
        "saved scrollback",
    );
    put(&root.join("oarlock-spaces.json"), "old spaces");
    put(&root.join("terminal-scrollback/stale.vt"), "old scrollback");
    put(
        &root.join(CHAT_STORE),
        r#"{"activeId":"stale","activeId:w-a":"chat-a","activeId:w-b":"chat-b","sessions":[{"id":"chat-a"}]}"#,
    );
    put(&root.join(REGISTRY_FILE), r#"{"windows":["w-a","w-b"]}"#);
    dir
}
fn prepared(root: &Path) {
    let plan = restore_plan(read_registry(&root.join(REGISTRY_FILE)).unwrap());
    prepare(root, &plan).unwrap();
}
fn verify(root: &Path) {
    assert_eq!(
        fs::read_to_string(root.join("oarlock-spaces.json")).unwrap(),
        "saved spaces"
    );
    assert_eq!(
        fs::read_to_string(root.join("terminal-scrollback/sb-1.vt")).unwrap(),
        "saved scrollback"
    );
    let chat = read_json(&root.join(CHAT_STORE)).unwrap().unwrap();
    assert_eq!(chat["activeId"], "chat-a");
    assert_eq!(chat["activeId:w-b"], "chat-b");
    assert!(chat.get("activeId:w-a").is_none());
    assert_eq!(chat["sessions"][0]["id"], "chat-a");
    assert_eq!(
        read_registry(&root.join(REGISTRY_FILE)).unwrap(),
        ["main", "w-b"]
    );
    assert!(!root.join(JOURNAL).exists());
}
#[test]
fn resumes_after_every_publication_and_commit_interruption() {
    // Four backups, four publications, then the durable commit marker.
    for stop_at in 1..=9 {
        let dir = fixture();
        prepared(dir.path());
        let mut step = 0;
        let error = recover(dir.path(), &mut || {
            step += 1;
            if step == stop_at {
                Err(fail("simulated interruption"))
            } else {
                Ok(())
            }
        });
        assert!(error.is_err(), "checkpoint {stop_at} not reached");
        run(dir.path()).unwrap();
        verify(dir.path());
    }
}
#[test]
fn replacement_during_recovery_is_preserved_and_blocks_startup() {
    let dir = fixture();
    let root = dir.path();
    prepared(root);
    recover(root, &mut || Err(fail("interrupted after backup"))).unwrap_err();
    put(&root.join("oarlock-spaces.json"), "new unrelated state");
    assert!(run(root)
        .unwrap_err()
        .to_string()
        .contains("restoration stopped"));
    assert_eq!(
        fs::read_to_string(root.join("oarlock-spaces.json")).unwrap(),
        "new unrelated state"
    );
    assert_eq!(
        fs::read_to_string(root.join("windows/w-a/oarlock-spaces.json")).unwrap(),
        "saved spaces"
    );
    assert_eq!(
        fs::read_to_string(root.join(JOURNAL).join("previous-0")).unwrap(),
        "old spaces"
    );
}
#[test]
fn damaged_registry_or_chat_is_not_replaced() {
    for file in [REGISTRY_FILE, CHAT_STORE] {
        let dir = fixture();
        put(&dir.path().join(file), "{broken");
        assert!(run(dir.path()).is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join(file)).unwrap(),
            "{broken"
        );
        assert!(dir.path().join("windows/w-a/oarlock-spaces.json").exists());
        assert!(!dir.path().join(JOURNAL).exists());
    }
}
#[test]
fn absent_source_state_clears_stale_main_without_leaving_stale_active_chat() {
    let dir = fixture();
    let root = dir.path();
    fs::remove_dir_all(root.join("windows/w-a")).unwrap();
    put(
        &root.join(CHAT_STORE),
        r#"{"activeId":"stale","sessions":[]}"#,
    );
    run(root).unwrap();
    assert!(!root.join("oarlock-spaces.json").exists());
    assert!(!root.join("terminal-scrollback").exists());
    assert!(read_json(&root.join(CHAT_STORE))
        .unwrap()
        .unwrap()
        .get("activeId")
        .is_none());
}
#[test]
fn committed_recovery_does_not_replay_over_later_state() {
    let dir = fixture();
    prepared(dir.path());
    let mut step = 0;
    recover(dir.path(), &mut || {
        step += 1;
        if step == 9 {
            Err(fail("interrupted"))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    put(&dir.path().join("oarlock-spaces.json"), "later state");
    run(dir.path()).unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("oarlock-spaces.json")).unwrap(),
        "later state"
    );
}
#[cfg(unix)]
#[test]
fn symlink_state_is_not_followed_or_removed() {
    let dir = fixture();
    let root = dir.path();
    fs::remove_file(root.join("windows/w-a/oarlock-spaces.json")).unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::write(outside.path(), "private data").unwrap();
    std::os::unix::fs::symlink(outside.path(), root.join("windows/w-a/oarlock-spaces.json"))
        .unwrap();
    assert!(run(root).is_err());
    assert_eq!(fs::read_to_string(outside.path()).unwrap(), "private data");
    assert_eq!(
        fs::read_to_string(root.join("oarlock-spaces.json")).unwrap(),
        "old spaces"
    );
}
#[cfg(target_os = "macos")]
#[test]
fn failed_rename_never_deletes_the_saved_source() {
    let dir = fixture();
    let root = dir.path();
    prepared(root);
    crate::modules::fs::access_control::tests::add_acl(root, "group:everyone deny delete_child");
    let result = run(root);
    let saved = fs::read_to_string(root.join("windows/w-a/oarlock-spaces.json"));
    // Remove the fixture ACL even if an assertion fails below.
    assert!(std::process::Command::new("chmod")
        .args(["-N"])
        .arg(root)
        .status()
        .unwrap()
        .success());
    assert!(result.is_err());
    assert_eq!(saved.unwrap(), "saved spaces");
    run(root).unwrap();
    verify(root);
}

#[test]
fn corrupt_manifest_preserves_all_original_state() {
    let dir = fixture();
    prepared(dir.path());
    put(&dir.path().join(JOURNAL).join("manifest.json"), "{broken");
    assert!(run(dir.path()).is_err());
    assert_eq!(
        fs::read_to_string(dir.path().join("windows/w-a/oarlock-spaces.json")).unwrap(),
        "saved spaces"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("oarlock-spaces.json")).unwrap(),
        "old spaces"
    );
}

#[test]
fn partial_commit_marker_can_resume_without_replaying_publication() {
    let dir = fixture();
    prepared(dir.path());
    let mut step = 0;
    recover(dir.path(), &mut || {
        step += 1;
        if step == 8 {
            Err(fail("interrupted"))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    put(&dir.path().join(JOURNAL).join("commit-ready"), "comm");
    run(dir.path()).unwrap();
    verify(dir.path());
}

#[cfg(unix)]
#[test]
fn source_directory_alias_does_not_move_external_state() {
    let dir = fixture();
    let external = tempfile::tempdir().unwrap();
    fs::rename(
        dir.path().join("windows/w-a"),
        external.path().join("saved"),
    )
    .unwrap();
    std::os::unix::fs::symlink(
        external.path().join("saved"),
        dir.path().join("windows/w-a"),
    )
    .unwrap();
    assert!(run(dir.path()).is_err());
    assert_eq!(
        fs::read_to_string(external.path().join("saved/oarlock-spaces.json")).unwrap(),
        "saved spaces"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("oarlock-spaces.json")).unwrap(),
        "old spaces"
    );
}

#[cfg(unix)]
#[test]
fn ordinary_launch_does_not_replace_the_saved_registry() {
    use std::os::unix::fs::MetadataExt;
    let dir = fixture();
    put(
        &dir.path().join(REGISTRY_FILE),
        "{\"windows\": [\"main\", \"w-a\"]}\n",
    );
    let path = dir.path().join(REGISTRY_FILE);
    let before = fs::metadata(&path).unwrap().ino();
    let bytes = fs::read(&path).unwrap();
    run(dir.path()).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().ino(), before);
    assert_eq!(fs::read(path).unwrap(), bytes);
}
