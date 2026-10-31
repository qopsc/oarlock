//! Conditional document writes. Only active callers retain per-path locks;
//! Versions bind content to the opened file, including across atomic replacement.
use super::{access_control::AccessControl, destination::Destination};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};

#[cfg(unix)]
pub(crate) fn identity(file: &fs::File) -> std::io::Result<String> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata()?;
    // Birth time prevents inode reuse. Older filesystems conservatively use
    // change time, which may also conflict on metadata-only changes.
    let generation = match meta.created() {
        Ok(created) => format!("birth:{created:?}"),
        Err(_) => format!("change:{}:{}", meta.ctime(), meta.ctime_nsec()),
    };
    Ok(format!("{}:{}:{generation}", meta.dev(), meta.ino()))
}

#[cfg(windows)]
pub(crate) fn identity(file: &fs::File) -> std::io::Result<String> {
    use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
    };
    let mut info = std::mem::MaybeUninit::<FILE_ID_INFO>::uninit();
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            info.as_mut_ptr().cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::other(format!(
            "Cannot obtain the file identity required for conditional saves: {}",
            std::io::Error::last_os_error()
        )));
    }
    let info = unsafe { info.assume_init() };
    Ok(format!(
        "{}:{:x}:{}",
        info.VolumeSerialNumber,
        u128::from_le_bytes(info.FileId.Identifier),
        file.metadata()?.creation_time(),
    ))
}

pub fn version(file: &fs::File, bytes: &[u8]) -> std::io::Result<String> {
    Ok(format!(
        "v2:{}:{:x}",
        identity(file)?,
        Sha256::digest(bytes)
    ))
}

fn key(path: &Path) -> PathBuf {
    #[cfg(any(windows, target_os = "macos"))]
    {
        PathBuf::from(super::to_canon(path).to_lowercase())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        path.to_path_buf()
    }
}

pub fn with_lock<T>(path: &Path, apply: impl FnOnce() -> T) -> T {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let lock = {
        let mut locks = LOCKS
            .get_or_init(Mutex::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        locks.retain(|_, lock| lock.strong_count() > 0);
        let entry = locks.entry(key(path)).or_default();
        if let Some(lock) = entry.upgrade() {
            lock
        } else {
            let lock = Arc::new(Mutex::new(()));
            *entry = Arc::downgrade(&lock);
            lock
        }
    };
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    apply()
}

#[derive(Debug)]
pub enum SaveError {
    Conflict(Option<String>),
    Failed(String),
}
impl From<std::io::Error> for SaveError {
    fn from(error: std::io::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

#[derive(PartialEq, Eq)]
pub(crate) struct ChangeStamp {
    len: u64,
    modified: std::time::SystemTime,
    changed: (i64, i64),
}

pub(crate) fn change_stamp(file: &fs::File) -> std::io::Result<ChangeStamp> {
    let meta = file.metadata()?;
    #[cfg(unix)]
    let changed = {
        use std::os::unix::fs::MetadataExt;
        (meta.ctime(), meta.ctime_nsec())
    };
    #[cfg(windows)]
    let changed = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO,
        };
        let mut info = FILE_BASIC_INFO::default();
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileBasicInfo,
                (&mut info as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        (info.ChangeTime, 0)
    };
    Ok(ChangeStamp {
        len: meta.len(),
        modified: meta.modified()?,
        changed,
    })
}

#[derive(Default)]
struct DiskState {
    version: Option<String>,
    identity: Option<String>,
    stamp: Option<ChangeStamp>,
    access: Option<AccessControl>,
}

fn current(
    destination: &Destination,
    validate: &impl Fn(&Path) -> Result<(), String>,
    limit: u64,
) -> Result<DiskState, SaveError> {
    let mut file = match destination.open_current() {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DiskState::default())
        }
        Err(error) => return Err(error.into()),
    };
    let identity = identity(&file)?;
    let stamp = change_stamp(&file)?;
    // open_current already matched the opened file to the pinned directory
    // entry. A file descriptor's reported name can be a different hard link.
    destination.validate(validate)?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut size = 0u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > limit {
            return Err(SaveError::Failed(
                format!("The file on disk exceeds the {limit}-byte save comparison limit"),
            ));
        }
        digest.update(&buffer[..count]);
    }
    let access = AccessControl::capture(&file)?;
    Ok(DiskState {
        version: Some(format!("v2:{identity}:{:x}", digest.finalize())),
        identity: Some(identity),
        stamp: Some(stamp),
        access: Some(access),
    })
}

/// Caller holds the canonical path lock. Stage before checking disk so changes
/// by external programs during the slow write/fsync are caught. Such programs
/// do not honor our lock: this final recheck is not a filesystem compare-and-swap.
pub fn write_checked(
    target: &Path,
    content: &[u8],
    expected: Option<&str>,
    validate: impl Fn(&Path) -> Result<(), String>,
) -> Result<String, SaveError> {
    write_checked_with_limit(target, content, expected, validate, 50 * 1024 * 1024)
}

pub(crate) fn write_checked_with_limit(
    target: &Path,
    content: &[u8],
    expected: Option<&str>,
    validate: impl Fn(&Path) -> Result<(), String>,
    limit: u64,
) -> Result<String, SaveError> {
    if content.len() as u64 > limit {
        return Err(SaveError::Failed(
            format!("The document exceeds the {limit}-byte save limit"),
        ));
    }
    let destination = Destination::pin(target, false, &validate)?;
    let staged = destination.stage(content)?;
    let actual = current(&destination, &validate, limit)?;
    if actual.version.as_deref() != expected {
        return Err(SaveError::Conflict(actual.version));
    }
    if let Some(access) = &actual.access {
        access.apply(staged.file())?;
    }
    destination.validate(&validate)?;
    if expected.is_some() {
        let (identity_now, stamp_now) = match destination.open_current() {
            Ok(file) => {
                if let Some(access) = &actual.access {
                    access.verify(&file)?;
                }
                (Some(identity(&file)?), Some(change_stamp(&file)?))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (None, None),
            Err(error) => return Err(error.into()),
        };
        if identity_now != actual.identity || stamp_now != actual.stamp {
            return Err(SaveError::Conflict(
                current(&destination, &validate, limit)?.version,
            ));
        }
    }
    if let Some(access) = &actual.access {
        access.verify(staged.file())?;
    }
    let saved = match staged.persist(expected.is_some()) {
        Ok(file) => file,
        Err(error) if expected.is_none() && error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(SaveError::Conflict(
                current(&destination, &validate, limit)?.version,
            ));
        }
        Err(error) => return Err(error.into()),
    };
    Ok(version(&saved, content)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, sync::Barrier};
    #[cfg(target_os = "linux")]
    #[test]
    fn replacement_preserves_permissions_on_overlay_filesystem() {
        use std::os::{fd::AsRawFd, unix::fs::PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document");
        fs::write(&path, b"base").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let file = fs::File::open(&path).unwrap();
        let mut state = std::mem::MaybeUninit::<libc::statfs>::uninit();
        assert_eq!(unsafe { libc::fstatfs(file.as_raw_fd(), state.as_mut_ptr()) }, 0);
        if unsafe { state.assume_init() }.f_type as u64 != 0x794c7630 {
            return;
        }
        save(&path, b"draft", Some(&disk_version(&path))).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"draft");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn replacement_preserves_quarantine_and_file_tags() {
        use std::os::fd::AsRawFd;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("document.txt");
        fs::write(&path, b"base").unwrap();
        let file = fs::File::open(&path).unwrap();
        let attrs = [
            (c"com.apple.quarantine", b"0083;00000000;OarlockReview;".as_slice()),
            (c"com.apple.metadata:_kMDItemUserTags", b"<?xml version=\"1.0\"?><plist version=\"1.0\"><array><string>Review</string></array></plist>".as_slice()),
        ];
        for (name, value) in attrs {
            assert_eq!(
                unsafe {
                    libc::fsetxattr(
                        file.as_raw_fd(),
                        name.as_ptr(),
                        value.as_ptr().cast(),
                        value.len(),
                        0,
                        0,
                    )
                },
                0
            );
        }
        drop(file);
        save(&path, b"edited", Some(&disk_version(&path))).unwrap();
        let saved = fs::File::open(&path).unwrap();
        let mut missing = Vec::new();
        for (name, expected) in attrs {
            let mut bytes = vec![0; 1024];
            let count = unsafe {
                libc::fgetxattr(
                    saved.as_raw_fd(),
                    name.as_ptr(),
                    bytes.as_mut_ptr().cast(),
                    bytes.len(),
                    0,
                    0,
                )
            };
            if count < 0 || &bytes[..count as usize] != expected {
                missing.push(name.to_string_lossy().into_owned());
            }
        }
        assert!(missing.is_empty(), "save removed metadata: {missing:?}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unsupported_extended_metadata_refuses_without_replacing_the_original() {
        use std::os::fd::AsRawFd;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("document.txt");
        fs::write(&path, b"original").unwrap();
        let file = fs::File::open(&path).unwrap();
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    file.as_raw_fd(),
                    c"com.oarlock.unsupported".as_ptr(),
                    b"value".as_ptr().cast(),
                    5,
                    0,
                    0,
                )
            },
            0
        );
        let expected = disk_version(&path);
        assert!(save(&path, b"edited", Some(&expected)).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(disk_version(&path), expected);
        let mut bytes = [0u8; 5];
        assert_eq!(
            unsafe {
                libc::fgetxattr(
                    file.as_raw_fd(),
                    c"com.oarlock.unsupported".as_ptr(),
                    bytes.as_mut_ptr().cast(),
                    5,
                    0,
                    0,
                )
            },
            5
        );
        assert_eq!(&bytes, b"value");
    }

    use tempfile::NamedTempFile;

    #[cfg(target_os = "macos")]
    #[test]
    fn replacement_preserves_acl_and_rejects_concurrent_acl_edits() {
        use super::super::access_control::tests::{acl_text, add_acl};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document");
        fs::write(&path, b"base").unwrap();
        add_acl(&path, "group:everyone deny execute");
        let rules = acl_text(&path);
        let saved = save(&path, b"draft", Some(&disk_version(&path))).unwrap();
        assert_eq!(acl_text(&path), rules);
        assert_eq!(fs::read(&path).unwrap(), b"draft");
        let calls = std::cell::Cell::new(0);
        let result = write_checked(&path, b"stale", Some(&saved), |_| {
            calls.set(calls.get() + 1);
            if calls.get() == 3 {
                add_acl(&path, "group:everyone deny write");
            }
            Ok(())
        });
        assert!(result.is_err());
        assert!(acl_text(&path).contains("deny write"));
        assert_eq!(fs::read(&path).unwrap(), b"draft");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unsupported_acl_keeps_original_and_cleans_up_the_candidate() {
        use super::super::access_control::tests::{acl_text, add_acl};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document");
        fs::write(&path, b"base").unwrap();
        add_acl(&path, "group:everyone deny delete");
        let rules = acl_text(&path);
        let result = save(&path, b"draft", Some(&disk_version(&path)));
        // Remove fixture protection before assertions so a failure still cleans up.
        let after = acl_text(&path);
        assert!(std::process::Command::new("/bin/chmod")
            .arg("-N")
            .arg(&path)
            .status()
            .unwrap()
            .success());
        assert!(
            matches!(result, Err(SaveError::Failed(ref message)) if message.contains("deny-delete"))
        );
        assert_eq!(after, rules);
        assert_eq!(fs::read(&path).unwrap(), b"base");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    fn disk_version(path: &Path) -> String {
        let mut file = fs::File::open(path).unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        version(&file, &bytes).unwrap()
    }

    fn save(path: &Path, content: &[u8], expected: Option<&str>) -> Result<String, SaveError> {
        with_lock(path, || write_checked(path, content, expected, |_| Ok(())))
    }

    #[cfg(unix)]
    #[test]
    fn parent_swap_before_acquisition_never_stages_content_outside_authority() {
        use crate::modules::workspace::{Origin, WorkspaceRegistry};
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("workspace");
        let outside = root.path().join("outside");
        fs::create_dir(&parent).unwrap();
        fs::create_dir(&outside).unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&parent).unwrap();
        let requested = parent.join("new");
        let gates = registry.gates(Origin::App);
        let target = gates.authorized_write_target(&requested).unwrap();
        fs::rename(&parent, root.path().join("previous")).unwrap();
        std::os::unix::fs::symlink(&outside, &parent).unwrap();
        let checked = std::cell::Cell::new(false);
        let result = write_checked(&target, b"SYNTHETIC_DRAFT", None, |opened| {
            checked.set(true);
            assert_eq!(
                fs::read_dir(&outside).unwrap().count(),
                0,
                "no staging before validation"
            );
            let current = gates.authorized_write_target(&requested)?;
            if current != target || opened != target {
                return Err("destination changed".into());
            }
            Ok(())
        });
        assert!(checked.get());
        assert!(matches!(result, Err(SaveError::Failed(_))));
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn identical_replacement_during_staging_conflicts_and_overwrite_uses_its_identity() {
        for phase in 1..=3 {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("document");
            fs::write(&path, b"base").unwrap();
            let expected = disk_version(&path);
            let calls = std::cell::Cell::new(0);
            let result = write_checked(&path, b"old draft", Some(&expected), |_| {
                calls.set(calls.get() + 1);
                if calls.get() == phase {
                    fs::remove_file(&path).unwrap();
                    fs::write(&path, b"base").unwrap();
                }
                Ok(())
            });
            let Err(SaveError::Conflict(Some(observed))) = result else {
                panic!("identical replacement accepted a stale draft")
            };
            assert_ne!(observed, expected);
            assert_eq!(fs::read(&path).unwrap(), b"base");
            assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
            let saved = save(&path, b"approved draft", Some(&observed)).unwrap();
            assert_eq!(saved, disk_version(&path));
            assert_ne!(saved, observed);
            assert!(save(&path, b"next edit", Some(&saved)).is_ok());
        }
    }

    #[test]
    fn in_place_edits_during_final_validation_are_conflicts() {
        for restore_mtime in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("document");
            fs::write(&path, b"base").unwrap();
            let expected = disk_version(&path);
            let mtime = fs::metadata(&path).unwrap().modified().unwrap();
            let external = if restore_mtime {
                b"edit".as_slice()
            } else {
                b"new content from another program".as_slice()
            };
            let calls = std::cell::Cell::new(0);
            let result = write_checked(&path, b"mine", Some(&expected), |_| {
                calls.set(calls.get() + 1);
                if calls.get() == 3 {
                    fs::write(&path, external).unwrap();
                    if restore_mtime {
                        fs::File::options()
                            .write(true)
                            .open(&path)
                            .unwrap()
                            .set_times(fs::FileTimes::new().set_modified(mtime))
                            .unwrap();
                    }
                }
                Ok(())
            });
            assert!(matches!(result, Err(SaveError::Conflict(_))));
            assert_eq!(fs::read(&path).unwrap(), external);
        }
    }

    #[test]
    fn atomic_replacement_with_identical_bytes_invalidates_even_an_overwrite_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document");
        fs::write(&path, b"base").unwrap();
        let observed = disk_version(&path);
        let mut replacement = NamedTempFile::new_in(dir.path()).unwrap();
        replacement.write_all(b"base").unwrap();
        replacement.persist(&path).unwrap();
        assert!(matches!(
            save(&path, b"mine", Some(&observed)),
            Err(SaveError::Conflict(Some(_)))
        ));
        assert_eq!(fs::read(&path).unwrap(), b"base");
    }

    #[test]
    fn timestamp_only_changes_preserve_versions_when_birth_time_is_available() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document");
        fs::write(&path, b"base").unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        let expected = disk_version(&path);
        file.set_times(
            fs::FileTimes::new()
                .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(60)),
        )
        .unwrap();
        if file.metadata().unwrap().created().is_ok() {
            assert_eq!(expected, disk_version(&path));
            assert!(save(&path, b"edit", Some(&expected)).is_ok());
        } else {
            assert!(matches!(
                save(&path, b"edit", Some(&expected)),
                Err(SaveError::Conflict(_))
            ));
        }
    }

    #[test]
    fn recovery_never_replaces_a_file_created_after_the_last_comparison() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recovered");
        let calls = std::cell::Cell::new(0);
        let result = write_checked(&path, b"draft", None, |_| {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                fs::write(&path, b"other window").unwrap();
            }
            Ok(())
        });
        assert!(matches!(result, Err(SaveError::Conflict(_))));
        assert_eq!(fs::read(&path).unwrap(), b"other window");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn concurrent_saves_have_one_winner_and_one_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("document");
        fs::write(&file, b"base").unwrap();
        let expected = disk_version(&file);
        let barrier = Arc::new(Barrier::new(3));
        let workers: Vec<_> = [b"first".as_slice(), b"second".as_slice()]
            .into_iter()
            .map(|content| {
                let (file, expected, barrier) = (file.clone(), expected.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    save(&file, content, Some(&expected))
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Err(SaveError::Conflict(_))))
                .count(),
            1
        );
        assert!(matches!(
            fs::read(&file).unwrap().as_slice(),
            b"first" | b"second"
        ));
    }

    #[test]
    fn contents_not_timestamps_decide_and_overwrite_is_conditional() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("document");
        fs::write(&file, b"base").unwrap();
        let expected = disk_version(&file);
        let mtime = fs::metadata(&file).unwrap().modified().unwrap();
        fs::write(&file, b"edit").unwrap();
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(mtime))
            .unwrap();
        let Err(SaveError::Conflict(Some(observed))) = save(&file, b"mine", Some(&expected)) else {
            panic!("missed same-timestamp change")
        };
        fs::write(&file, b"newer").unwrap();
        assert!(matches!(
            save(&file, b"mine", Some(&observed)),
            Err(SaveError::Conflict(_))
        ));
        assert_eq!(fs::read(&file).unwrap(), b"newer");
        assert!(save(&file, b"mine", Some(&disk_version(&file))).is_ok());
    }

    #[test]
    fn deletion_and_recreation_are_conflicts_until_explicitly_acknowledged() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("document");
        fs::write(&file, b"base").unwrap();
        let expected = disk_version(&file);
        fs::remove_file(&file).unwrap();
        assert!(matches!(
            save(&file, b"mine", Some(&expected)),
            Err(SaveError::Conflict(None))
        ));
        assert!(!file.exists());
        assert!(save(&file, b"mine", None).is_ok());
        assert!(matches!(
            save(&file, b"other", None),
            Err(SaveError::Conflict(Some(_)))
        ));
    }

    #[test]
    fn edits_during_staging_are_caught_and_failed_saves_leave_no_temporary_files() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("document");
        fs::write(&file, b"base").unwrap();
        let expected = disk_version(&file);
        let changed = std::cell::Cell::new(false);
        let result = with_lock(&file, || {
            write_checked(&file, b"mine", Some(&expected), |_| {
                if !changed.replace(true) {
                    fs::write(&file, b"external").unwrap();
                }
                Ok(())
            })
        });
        assert!(matches!(result, Err(SaveError::Conflict(_))));
        assert_eq!(fs::read(&file).unwrap(), b"external");
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
        assert!(matches!(
            with_lock(&file, || write_checked(
                &file,
                b"mine",
                Some(&disk_version(&file)),
                |_| Err("access revoked".into())
            )),
            Err(SaveError::Failed(_))
        ));
        assert_eq!(fs::read(&file).unwrap(), b"external");
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn canonical_aliases_share_a_transaction_and_preserve_the_link_and_mode() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("document");
        let link = tmp.path().join("link");
        fs::write(&file, b"base").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o751)).unwrap();
        symlink(&file, &link).unwrap();
        let expected = disk_version(&file);
        let canonical = fs::canonicalize(&link).unwrap();
        assert!(save(&canonical, b"first", Some(&expected)).is_ok());
        assert!(matches!(
            save(
                &fs::canonicalize(&file).unwrap(),
                b"second",
                Some(&expected)
            ),
            Err(SaveError::Conflict(_))
        ));
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o751
        );
    }
}
