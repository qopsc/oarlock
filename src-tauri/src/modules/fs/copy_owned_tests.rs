use super::*;

fn fixture() -> (
    tempfile::TempDir,
    std::path::PathBuf,
    std::path::PathBuf,
    WorkspaceRegistry,
) {
    let tmp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(tmp.path()).unwrap();
    let src = root.join("source");
    let dest = root.join("destination");
    fs::create_dir(&src).unwrap();
    fs::create_dir(&dest).unwrap();
    let registry = WorkspaceRegistry::default();
    registry.authorize(&root).unwrap();
    (tmp, src, dest, registry)
}

#[cfg(target_os = "macos")]
#[test]
fn dormant_batch_copies_regular_files_without_replacing_conflicts() {
    let (_tmp, src, dest, registry) = fixture();
    fs::write(src.join("a.txt"), "new").unwrap();
    fs::write(dest.join("a.txt"), "old").unwrap();
    let path = |p: &Path| p.to_string_lossy().into_owned();
    let result = copy_batch_impl(
        vec![path(&src.join("a.txt"))],
        &path(&dest),
        &path(&dest),
        &WorkspaceEnv::Local,
        &registry,
        &FileIndexState::default(),
        true,
    )
    .unwrap();
    assert!(result.failed.is_empty(), "{:?}", result.failed);
    assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "old");
    assert_eq!(fs::read_to_string(dest.join("a copy.txt")).unwrap(), "new");
}

#[cfg(unix)]
#[test]
fn replacing_source_after_open_never_copies_the_replacement() {
    use std::os::unix::fs::symlink;
    let (_tmp, src, dest, registry) = fixture();
    let source = src.join("a");
    let outside = tempfile::tempdir().unwrap();
    fs::write(&source, "authorized").unwrap();
    fs::write(outside.path().join("secret"), "secret").unwrap();
    let dir = Dir::open_ambient_dir(&dest, cap_std::ambient_authority()).unwrap();
    let ctx = CopyContext {
        dir: &dir,
        destination: &dest,
        root: &dest,
        registry: &registry,
        rename_on_conflict: false,
    };
    let outcome = copy_file(
        &source,
        &ctx,
        || {
            fs::rename(&source, src.join("original")).unwrap();
            symlink(outside.path().join("secret"), &source).unwrap();
        },
        || {},
    );
    assert!(outcome.is_err());
    assert!(!dest.join("a").exists());
}

#[cfg(unix)]
#[test]
fn replacing_source_parent_before_open_cannot_read_outside_file() {
    use std::os::unix::fs::symlink;
    let (tmp, src, dest, registry) = fixture();
    let source = src.join("a");
    fs::write(&source, "authorized").unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("a"), "private").unwrap();
    let dir = Dir::open_ambient_dir(&dest, cap_std::ambient_authority()).unwrap();
    let ctx = CopyContext {
        dir: &dir,
        destination: &dest,
        root: &dest,
        registry: &registry,
        rename_on_conflict: false,
    };
    fs::rename(&src, tmp.path().join("original")).unwrap();
    symlink(outside.path(), &src).unwrap();
    assert!(copy_file(&source, &ctx, || {}, || {}).is_err());
    assert!(!dest.join("a").exists());
}

#[cfg(unix)]
#[test]
fn replacing_destination_parent_does_not_write_to_new_target() {
    use std::os::unix::fs::symlink;
    let (tmp, src, dest, registry) = fixture();
    let source = src.join("a");
    fs::write(&source, "data").unwrap();
    let outside = tempfile::tempdir().unwrap();
    let dir = Dir::open_ambient_dir(&dest, cap_std::ambient_authority()).unwrap();
    let ctx = CopyContext {
        dir: &dir,
        destination: &dest,
        root: &dest,
        registry: &registry,
        rename_on_conflict: false,
    };
    let outcome = copy_file(
        &source,
        &ctx,
        || {},
        || {
            fs::rename(&dest, tmp.path().join("moved")).unwrap();
            symlink(outside.path(), &dest).unwrap();
        },
    );
    assert!(outcome.is_err());
    assert!(!outside.path().join("a").exists());
}

#[cfg(target_os = "macos")]
#[test]
fn final_destination_symlink_is_not_overwritten_or_followed() {
    use std::os::unix::fs::symlink;
    let (_tmp, src, dest, registry) = fixture();
    let source = src.join("a");
    fs::write(&source, "data").unwrap();
    let outside = tempfile::tempdir().unwrap();
    let victim = outside.path().join("victim");
    fs::write(&victim, "untouched").unwrap();
    let dir = Dir::open_ambient_dir(&dest, cap_std::ambient_authority()).unwrap();
    let ctx = CopyContext {
        dir: &dir,
        destination: &dest,
        root: &dest,
        registry: &registry,
        rename_on_conflict: false,
    };
    let result = copy_file(
        &source,
        &ctx,
        || {},
        || symlink(&victim, dest.join("a")).unwrap(),
    );
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read_to_string(victim).unwrap(), "untouched");
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn directories_and_links_are_refused_without_partial_copies() {
    use std::os::unix::fs::symlink;
    let (_tmp, src, dest, registry) = fixture();
    fs::create_dir(src.join("folder")).unwrap();
    symlink("folder", src.join("link")).unwrap();
    let path = |p: &Path| p.to_string_lossy().into_owned();
    let result = copy_batch_impl(
        vec![path(&src.join("folder")), path(&src.join("link"))],
        &path(&dest),
        &path(&dest),
        &WorkspaceEnv::Local,
        &registry,
        &FileIndexState::default(),
        false,
    )
    .unwrap();
    assert!(result.created.is_empty());
    assert_eq!(result.failed.len(), 2);
    assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);
}

#[cfg(target_os = "macos")]
#[test]
fn copies_links_as_entries_without_following_targets() {
    use std::os::unix::fs::symlink;
    let (_tmp, src, dest, registry) = fixture();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("private"), "secret").unwrap();
    symlink(outside.path().join("private"), src.join("file-link")).unwrap();
    symlink("missing", src.join("dangling")).unwrap();
    symlink(outside.path(), src.join("directory-link")).unwrap();
    let path = |p: &Path| p.to_string_lossy().into_owned();
    let result = copy_batch_impl(
        ["file-link", "dangling", "directory-link"]
            .iter()
            .map(|name| path(&src.join(name)))
            .collect(),
        &path(&dest),
        &path(&dest),
        &WorkspaceEnv::Local,
        &registry,
        &FileIndexState::default(),
        false,
    )
    .unwrap();
    assert!(result.failed.is_empty(), "{:?}", result.failed);
    assert_eq!(
        fs::read_link(dest.join("file-link")).unwrap(),
        outside.path().join("private")
    );
    assert_eq!(
        fs::read_link(dest.join("dangling")).unwrap(),
        Path::new("missing")
    );
    assert_eq!(
        fs::read_link(dest.join("directory-link")).unwrap(),
        outside.path()
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("private")).unwrap(),
        "secret"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn a_replaced_source_link_is_never_copied_from_its_new_entry() {
    use std::os::unix::fs::symlink;
    let (_tmp, src, dest, registry) = fixture();
    let source = src.join("link");
    symlink("original-target", &source).unwrap();
    let dir = Dir::open_ambient_dir(&dest, cap_std::ambient_authority()).unwrap();
    let ctx = CopyContext {
        dir: &dir,
        destination: &dest,
        root: &dest,
        registry: &registry,
        rename_on_conflict: false,
    };
    let result = copy_file(
        &source,
        &ctx,
        || {},
        || {
            fs::remove_file(&source).unwrap();
            symlink("replacement-target", &source).unwrap();
        },
    );
    if result.is_ok() {
        assert_eq!(
            fs::read_link(dest.join("link")).unwrap(),
            Path::new("original-target")
        );
    } else {
        assert!(fs::symlink_metadata(dest.join("link")).is_err());
    }
}

#[cfg(target_os = "macos")]
#[test]
fn directories_are_refused_without_partial_copies() {
    let (_tmp, src, dest, registry) = fixture();
    fs::create_dir(src.join("folder")).unwrap();
    let path = |p: &Path| p.to_string_lossy().into_owned();
    let result = copy_batch_impl(
        vec![path(&src.join("folder"))],
        &path(&dest),
        &path(&dest),
        &WorkspaceEnv::Local,
        &registry,
        &FileIndexState::default(),
        false,
    )
    .unwrap();
    assert!(result.created.is_empty());
    assert_eq!(result.failed.len(), 1);
    assert_eq!(fs::read_dir(dest).unwrap().count(), 0);
}

#[cfg(target_os = "macos")]
#[test]
fn folder_replaced_after_open_cannot_copy_its_new_target() {
    use std::os::unix::fs::symlink;
    let (_tmp, src, dest, registry) = fixture();
    let folder = src.join("folder");
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("public"), "public").unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("private"), "private").unwrap();
    let dir = Dir::open_ambient_dir(&dest, cap_std::ambient_authority()).unwrap();
    let context = CopyContext {
        dir: &dir,
        destination: &dest,
        root: &dest,
        registry: &registry,
        rename_on_conflict: false,
    };
    let result = copy_file(
        &folder,
        &context,
        || {
            fs::rename(&folder, src.join("original")).unwrap();
            symlink(outside.path(), &folder).unwrap();
        },
        || {},
    );
    assert!(result.is_err());
    assert!(fs::symlink_metadata(dest.join("folder")).is_err());
    assert_eq!(
        fs::read_to_string(outside.path().join("private")).unwrap(),
        "private"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn folder_with_nested_outside_link_leaves_no_partial_copy() {
    use std::os::unix::fs::symlink;
    let (_tmp, src, dest, registry) = fixture();
    let folder = src.join("folder");
    fs::create_dir(&folder).unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("private"), "private").unwrap();
    symlink(outside.path(), folder.join("link")).unwrap();
    let path = |p: &Path| p.to_string_lossy().into_owned();
    let result = copy_batch_impl(
        vec![path(&folder)],
        &path(&dest),
        &path(&dest),
        &WorkspaceEnv::Local,
        &registry,
        &FileIndexState::default(),
        false,
    )
    .unwrap();
    assert!(result.created.is_empty());
    assert_eq!(result.failed.len(), 1);
    assert_eq!(fs::read_dir(dest).unwrap().count(), 0);
    assert_eq!(
        fs::read_to_string(outside.path().join("private")).unwrap(),
        "private"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn simultaneous_dormant_copies_choose_distinct_names() {
    let (_tmp, src, dest, registry) = fixture();
    let source = src.join("file.txt");
    fs::write(&source, "data").unwrap();
    let barrier = std::sync::Barrier::new(3);
    std::thread::scope(|threads| {
        let handles: Vec<_> = (0..3)
            .map(|_| {
                threads.spawn(|| {
                    let path = |p: &Path| p.to_string_lossy().into_owned();
                    barrier.wait();
                    copy_batch_impl(
                        vec![path(&source)],
                        &path(&dest),
                        &path(&dest),
                        &WorkspaceEnv::Local,
                        &registry,
                        &FileIndexState::default(),
                        true,
                    )
                    .unwrap()
                })
            })
            .collect();
        let mut names = std::collections::HashSet::new();
        for handle in handles {
            let result = handle.join().unwrap();
            assert!(result.failed.is_empty(), "{:?}", result.failed);
            assert!(names.insert(result.created[0].clone()));
            assert_eq!(fs::read_to_string(&result.created[0]).unwrap(), "data");
        }
    });
}

#[test]
fn unauthorized_source_fails_without_publishing_anything() {
    let (_tmp, _src, dest, registry) = fixture();
    let outside = tempfile::tempdir().unwrap();
    let source = outside.path().join("private");
    fs::write(&source, "private").unwrap();
    let path = |p: &Path| p.to_string_lossy().into_owned();
    let result = copy_batch_impl(
        vec![path(&source)],
        &path(&dest),
        &path(&dest),
        &WorkspaceEnv::Local,
        &registry,
        &FileIndexState::default(),
        false,
    )
    .unwrap();
    assert!(result.created.is_empty());
    assert_eq!(result.failed.len(), 1);
    assert_eq!(fs::read_dir(dest).unwrap().count(), 0);
}

#[cfg(not(target_os = "macos"))]
#[test]
fn unsupported_platform_does_not_publish_a_file() {
    let (_tmp, src, dest, registry) = fixture();
    let source = src.join("a");
    fs::write(&source, "data").unwrap();
    let path = |p: &Path| p.to_string_lossy().into_owned();
    let result = copy_batch_impl(
        vec![path(&source)],
        &path(&dest),
        &path(&dest),
        &WorkspaceEnv::Local,
        &registry,
        &FileIndexState::default(),
        false,
    )
    .unwrap();
    assert!(result.created.is_empty());
    assert_eq!(result.failed.len(), 1);
    assert!(!dest.join("a").exists());
}

#[test]
fn guarded_batch_refuses_copy_without_mutating_the_destination() {
    let (_tmp, src, dest, registry) = fixture();
    let source = src.join("file.txt");
    fs::write(&source, "source").unwrap();
    let text = |p: &Path| p.to_string_lossy().into_owned();
    let result = copy_batch(
        vec![text(&source)],
        &text(&dest),
        &text(&dest),
        &WorkspaceEnv::Local,
        &registry,
        &FileIndexState::default(),
        false,
    );
    assert!(result.unwrap_err().contains("cannot be safely verified"));
    assert_eq!(fs::read_to_string(source).unwrap(), "source");
    assert_eq!(fs::read_dir(dest).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn guarded_batch_does_not_write_when_destination_has_moved_outside() {
    use std::os::unix::fs::symlink;
    let (_tmp, src, dest, registry) = fixture();
    let source = src.join("file.txt");
    fs::write(&source, "source").unwrap();
    let outside = tempfile::tempdir().unwrap();
    let moved = outside.path().join("moved");
    fs::rename(&dest, &moved).unwrap();
    symlink(outside.path(), &dest).unwrap();
    let text = |p: &Path| p.to_string_lossy().into_owned();
    let result = copy_batch(
        vec![text(&source)],
        &text(&dest),
        &text(&dest),
        &WorkspaceEnv::Local,
        &registry,
        &FileIndexState::default(),
        false,
    );
    assert!(result.unwrap_err().contains("cannot be safely verified"));
    assert!(!outside.path().join("file.txt").exists());
    assert!(!moved.join("file.txt").exists());
}
