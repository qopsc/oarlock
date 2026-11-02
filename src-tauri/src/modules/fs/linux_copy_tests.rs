use super::*;
use crate::modules::fs::linux_staging::tests::test_dir;
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
};

const ACL_NAME: &std::ffi::CStr = c"system.posix_acl_access";
const DEFAULT_ACL_NAME: &std::ffi::CStr = c"system.posix_acl_default";

struct Fixture {
    _root: tempfile::TempDir,
    src: PathBuf,
    dest: PathBuf,
    cache: PathBuf,
}
fn fixture() -> Fixture {
    let root = test_dir();
    let base = fs::canonicalize(root.path()).unwrap();
    let (src, dest, cache) = (base.join("src"), base.join("dest"), base.join("cache"));
    for dir in [&src, &dest, &cache] {
        fs::create_dir(dir).unwrap();
    }
    fs::set_permissions(&cache, fs::Permissions::from_mode(0o700)).unwrap();
    Fixture {
        _root: root,
        src,
        dest,
        cache,
    }
}
fn ok_validate() -> io::Result<()> {
    Ok(())
}
fn ok_guard(_: &Path) -> io::Result<()> {
    Ok(())
}
fn ok_link(_: &Path, _: &Path, _: &Path) -> io::Result<()> {
    Ok(())
}
impl Fixture {
    fn copy(&self, name: &str) -> io::Result<OsString> {
        self.copy_with(name, false, &REAL, Some(self.cache.clone()), &ok_link, || {})
    }
    fn copy_with(
        &self,
        name: &str,
        rename_on_conflict: bool,
        sys: &Sys,
        cache: Option<PathBuf>,
        link_ok: &dyn Fn(&Path, &Path, &Path) -> io::Result<()>,
        before_publish: impl FnOnce(),
    ) -> io::Result<OsString> {
        let dir = Dir::open_ambient_dir(&self.dest, cap_std::ambient_authority()).unwrap();
        let env = Env {
            dir: &dir,
            destination: &self.dest,
            rename_on_conflict,
            validate: &ok_validate,
            guard: &ok_guard,
            link_ok,
        };
        let source = self.src.join(name);
        let handle = open_source(&source)?;
        copy_item(&source, &handle, OsStr::new(name), &env, sys, cache, before_publish)
    }
    fn staging_is_empty(&self) -> bool {
        let staging = self.cache.join("oarlock-staging");
        !staging.exists() || fs::read_dir(staging).unwrap().count() == 0
    }
}
fn acl_bytes(user: u32) -> Vec<u8> {
    let mut bytes = 2u32.to_le_bytes().to_vec();
    let owner = 6u16;
    for (tag, permissions, id) in [
        (1u16, owner, u32::MAX),
        (2, 4, user),
        (4, 0, u32::MAX),
        (16, 4, u32::MAX),
        (32, 0, u32::MAX),
    ] {
        bytes.extend_from_slice(&tag.to_le_bytes());
        bytes.extend_from_slice(&permissions.to_le_bytes());
        bytes.extend_from_slice(&id.to_le_bytes());
    }
    bytes
}
fn set_xattr(path: &Path, name: &std::ffi::CStr, value: &[u8]) -> bool {
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    unsafe {
        libc::setxattr(path.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0)
            == 0
    }
}
fn get_xattr(path: &Path, name: &std::ffi::CStr) -> Option<Vec<u8>> {
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    let mut buffer = vec![0u8; 4096];
    let n = unsafe {
        libc::getxattr(path.as_ptr(), name.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len())
    };
    (n >= 0).then(|| buffer[..n as usize].to_vec())
}
fn mode(path: &Path) -> u32 {
    fs::symlink_metadata(path).unwrap().permissions().mode() & 0o7777
}
fn restore(path: &Path) {
    // Let the temporary directory clean itself up.
    if let Ok(entries) = fs::read_dir(path) {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                restore(&entry.path());
            }
        }
    }
}
fn payload(length: usize) -> Vec<u8> {
    (0..length).map(|n| (n * 31 % 251) as u8).collect()
}

#[test]
fn file_copy_keeps_content_mode_acl_xattrs_and_times() {
    let f = fixture();
    let source = f.src.join("file");
    let data = payload(3 * 1024 * 1024 + 17);
    fs::write(&source, &data).unwrap();
    fs::set_permissions(&source, fs::Permissions::from_mode(0o640)).unwrap();
    assert!(set_xattr(&source, c"user.oarlock", b"kept"), "user xattrs unsupported here");
    assert!(set_xattr(&source, ACL_NAME, &acl_bytes(65534)), "POSIX ACLs unsupported here");
    let mtime = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
    fs::File::options().write(true).open(&source).unwrap().set_modified(mtime).unwrap();
    assert_eq!(f.copy("file").unwrap(), "file");
    let copy = f.dest.join("file");
    assert_eq!(fs::read(&copy).unwrap(), data);
    assert_eq!(get_xattr(&copy, c"user.oarlock").unwrap(), b"kept");
    assert_eq!(get_xattr(&copy, ACL_NAME), get_xattr(&source, ACL_NAME));
    assert_eq!(mode(&copy), mode(&source));
    assert_eq!(fs::metadata(&copy).unwrap().modified().unwrap(), mtime);
    assert!(f.staging_is_empty());
}

#[test]
fn folder_copy_keeps_nested_metadata_and_applies_folder_metadata_after_children() {
    let f = fixture();
    let top = f.src.join("tree");
    fs::create_dir_all(top.join("ro/deeper")).unwrap();
    fs::write(top.join("ro/deeper/leaf"), "leaf").unwrap();
    fs::write(top.join("top-file"), "top").unwrap();
    symlink("top-file", top.join("inside-link")).unwrap();
    assert!(set_xattr(&top.join("ro"), c"user.folder", b"v"));
    fs::set_permissions(top.join("ro/deeper"), fs::Permissions::from_mode(0o555)).unwrap();
    fs::set_permissions(top.join("ro"), fs::Permissions::from_mode(0o550)).unwrap();
    fs::set_permissions(&top, fs::Permissions::from_mode(0o750)).unwrap();
    let result = f.copy("tree");
    restore(&top);
    result.unwrap();
    let copy = f.dest.join("tree");
    assert_eq!(mode(&copy), 0o750);
    assert_eq!(mode(&copy.join("ro")), 0o550);
    assert_eq!(mode(&copy.join("ro/deeper")), 0o555);
    assert_eq!(get_xattr(&copy.join("ro"), c"user.folder").unwrap(), b"v");
    assert_eq!(fs::read(copy.join("ro/deeper/leaf")).unwrap(), b"leaf");
    assert_eq!(fs::read_link(copy.join("inside-link")).unwrap(), Path::new("top-file"));
    restore(&copy);
    assert!(f.staging_is_empty());
}

#[test]
fn a_read_only_top_level_folder_is_copied_without_privileges() {
    let f = fixture();
    let top = f.src.join("locked");
    fs::create_dir_all(top.join("inner")).unwrap();
    fs::write(top.join("inner/file"), "x").unwrap();
    fs::set_permissions(top.join("inner"), fs::Permissions::from_mode(0o500)).unwrap();
    fs::set_permissions(&top, fs::Permissions::from_mode(0o555)).unwrap();
    let times = fs::metadata(&top).unwrap().modified().unwrap();
    let result = f.copy("locked");
    restore(&top);
    result.unwrap();
    let copy = f.dest.join("locked");
    assert_eq!(mode(&copy), 0o555);
    assert_eq!(mode(&copy.join("inner")), 0o500);
    assert_eq!(fs::metadata(&copy).unwrap().modified().unwrap(), times);
    restore(&copy);
}

#[test]
fn a_failed_copy_with_a_read_only_nested_folder_leaves_no_staging() {
    let f = fixture();
    let top = f.src.join("tree");
    fs::create_dir_all(top.join("ro/deeper")).unwrap();
    fs::write(top.join("ro/deeper/file"), "x").unwrap();
    fs::set_permissions(top.join("ro/deeper"), fs::Permissions::from_mode(0o555)).unwrap();
    fs::set_permissions(top.join("ro"), fs::Permissions::from_mode(0o555)).unwrap();
    let dir = Dir::open_ambient_dir(&f.dest, cap_std::ambient_authority()).unwrap();
    let refuse = |_: &Path| Err(io::Error::other("refused at publication"));
    let env = Env {
        dir: &dir,
        destination: &f.dest,
        rename_on_conflict: false,
        validate: &ok_validate,
        guard: &refuse,
        link_ok: &ok_link,
    };
    let handle = open_source(&top).unwrap();
    let error = copy_item(&top, &handle, OsStr::new("tree"), &env, &REAL, Some(f.cache.clone()), || {})
        .unwrap_err();
    restore(&top);
    assert!(error.to_string().contains("refused"), "{error}");
    assert_eq!(fs::read_dir(&f.dest).unwrap().count(), 0);
    assert!(f.staging_is_empty());
}

#[test]
fn default_acls_on_folders_round_trip_and_none_is_inherited_when_absent() {
    let f = fixture();
    let with = f.src.join("with");
    let without = f.src.join("without");
    fs::create_dir(&with).unwrap();
    fs::create_dir(&without).unwrap();
    assert!(set_xattr(&with, DEFAULT_ACL_NAME, &acl_bytes(65534)), "default ACLs unsupported here");
    // A staging folder that already carries a default ACL must not leak it.
    let staging = f.cache.join("oarlock-staging");
    fs::create_dir(&staging).unwrap();
    fs::set_permissions(&staging, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(set_xattr(&staging, DEFAULT_ACL_NAME, &acl_bytes(65533)));
    f.copy("with").unwrap();
    f.copy("without").unwrap();
    assert_eq!(get_xattr(&f.dest.join("with"), DEFAULT_ACL_NAME), get_xattr(&with, DEFAULT_ACL_NAME));
    assert_eq!(get_xattr(&f.dest.join("without"), DEFAULT_ACL_NAME), None);
}

#[test]
fn links_are_copied_as_links_and_never_followed() {
    let f = fixture();
    fs::write(f.src.join("target"), "secret").unwrap();
    symlink("target", f.src.join("relative")).unwrap();
    symlink("missing", f.src.join("dangling")).unwrap();
    symlink("/etc", f.src.join("absolute")).unwrap();
    for name in ["relative", "dangling", "absolute"] {
        f.copy(name).unwrap();
        assert_eq!(
            fs::read_link(f.dest.join(name)).unwrap(),
            fs::read_link(f.src.join(name)).unwrap()
        );
    }
    assert!(!f.dest.join("target").exists());
}

#[test]
fn a_nested_link_the_caller_refuses_leaves_no_partial_copy() {
    let f = fixture();
    let top = f.src.join("tree");
    fs::create_dir(&top).unwrap();
    fs::write(top.join("a-file"), "x").unwrap();
    symlink("../escape", top.join("link")).unwrap();
    let refuse = |_: &Path, _: &Path, _: &Path| Err(io::Error::other("escapes"));
    let error = f
        .copy_with("tree", false, &REAL, Some(f.cache.clone()), &refuse, || {})
        .unwrap_err();
    assert!(error.to_string().contains("escapes"));
    assert_eq!(fs::read_dir(&f.dest).unwrap().count(), 0);
    assert!(f.staging_is_empty());
}

#[test]
fn an_existing_destination_is_not_replaced_and_conflicts_get_a_copy_name() {
    let f = fixture();
    fs::write(f.src.join("a.txt"), "new").unwrap();
    fs::write(f.dest.join("a.txt"), "old").unwrap();
    let error = f.copy("a.txt").unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read(f.dest.join("a.txt")).unwrap(), b"old");
    let name = f
        .copy_with("a.txt", true, &REAL, Some(f.cache.clone()), &ok_link, || {})
        .unwrap();
    assert_eq!(name, "a copy.txt");
    assert_eq!(fs::read(f.dest.join("a copy.txt")).unwrap(), b"new");
    assert_eq!(fs::read(f.dest.join("a.txt")).unwrap(), b"old");
}

#[test]
fn special_files_and_privileged_modes_are_refused_without_a_partial_copy() {
    let f = fixture();
    let fifo = CString::new(f.src.join("pipe").as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let error = f.copy("pipe").unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Unsupported);
    let top = f.src.join("tree");
    fs::create_dir(&top).unwrap();
    fs::write(top.join("fine"), "x").unwrap();
    let nested = CString::new(top.join("pipe").as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(nested.as_ptr(), 0o600) }, 0);
    assert!(f.copy("tree").is_err());
    fs::write(f.src.join("suid"), "x").unwrap();
    fs::set_permissions(f.src.join("suid"), fs::Permissions::from_mode(0o4755)).unwrap();
    assert!(f.copy("suid").unwrap_err().to_string().contains("setuid"));
    assert_eq!(fs::read_dir(&f.dest).unwrap().count(), 0);
    assert!(f.staging_is_empty());
}

fn zero_range(_: RawFd, _: RawFd, _: usize) -> io::Result<usize> {
    Ok(0)
}
fn four_at_a_time(from: RawFd, to: RawFd, _: usize) -> io::Result<usize> {
    real_copy_file_range(from, to, 4)
}
fn unsupported_range(_: RawFd, _: RawFd, _: usize) -> io::Result<usize> {
    Err(io::Error::from_raw_os_error(libc::EXDEV))
}

#[test]
fn zero_short_and_unsupported_copy_file_range_still_copy_every_byte() {
    let f = fixture();
    let data = payload(100_003);
    fs::write(f.src.join("data"), &data).unwrap();
    for (n, range) in [zero_range, four_at_a_time, unsupported_range].into_iter().enumerate() {
        let sys = Sys {
            copy_file_range: range,
            ..REAL
        };
        let _ = fs::remove_file(f.dest.join("data"));
        f.copy_with("data", false, &sys, Some(f.cache.clone()), &ok_link, || {})
            .unwrap();
        assert_eq!(fs::read(f.dest.join("data")).unwrap(), data, "variant {n}");
    }
}

#[test]
fn a_filesystem_without_noreplace_is_a_refusal_not_a_plain_rename() {
    fn einval(_: RawFd, _: &OsStr, _: RawFd, _: &OsStr) -> io::Result<()> {
        Err(crate::modules::fs::linux_staging::noreplace_error(
            io::Error::from_raw_os_error(libc::EINVAL),
        ))
    }
    let f = fixture();
    fs::write(f.src.join("file"), "x").unwrap();
    let sys = Sys {
        renameat2: einval,
        ..REAL
    };
    let error = f
        .copy_with("file", false, &sys, Some(f.cache.clone()), &ok_link, || {})
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Unsupported);
    assert!(error.to_string().contains("RENAME_NOREPLACE"));
    assert_eq!(fs::read_dir(&f.dest).unwrap().count(), 0);
    assert!(f.staging_is_empty());
}

#[test]
fn a_cross_mount_error_restages_in_the_next_location() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    fn exdev_once(from: RawFd, from_name: &OsStr, to: RawFd, to_name: &OsStr) -> io::Result<()> {
        if CALLS.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(io::Error::from_raw_os_error(libc::EXDEV));
        }
        rename_noreplace_at(from, from_name, to, to_name)
    }
    let f = fixture();
    fs::write(f.src.join("file"), "kept").unwrap();
    let sys = Sys {
        renameat2: exdev_once,
        ..REAL
    };
    // The cache is the first location; the folder's own private child is the next.
    f.copy_with("file", false, &sys, Some(f.cache.clone()), &ok_link, || {})
        .unwrap();
    assert_eq!(CALLS.load(Ordering::SeqCst), 2);
    assert_eq!(fs::read(f.dest.join("file")).unwrap(), b"kept");
    assert!(!f.dest.join(".oarlock-staging").exists());
}

#[test]
fn a_missing_cache_and_an_unusable_one_both_still_copy() {
    let f = fixture();
    fs::write(f.src.join("file"), "x").unwrap();
    let missing = f.cache.join("fresh/cache");
    f.copy_with("file", false, &REAL, Some(missing.clone()), &ok_link, || {})
        .unwrap();
    assert_eq!(mode(&missing), 0o700);
    fs::remove_file(f.dest.join("file")).unwrap();
    let not_a_dir = f.cache.join("plain-file");
    fs::write(&not_a_dir, "").unwrap();
    f.copy_with("file", false, &REAL, Some(not_a_dir), &ok_link, || {})
        .unwrap();
    assert_eq!(fs::read(f.dest.join("file")).unwrap(), b"x");
    assert!(!f.dest.join(".oarlock-staging").exists());
}

#[test]
fn a_live_copy_area_survives_another_copys_stale_sweep() {
    let f = fixture();
    let dir = Dir::open_ambient_dir(&f.dest, cap_std::ambient_authority()).unwrap();
    let first = CopyArea::create_with_cache(&dir, Some(f.cache.clone()), 0).unwrap();
    let path = super::super::attachment::handle_path(&first.dir().unwrap().into_std_file()).unwrap();
    let old = [libc::timespec { tv_sec: 1, tv_nsec: 0 }; 2];
    assert_eq!(unsafe { libc::futimens(first.fd(), old.as_ptr()) }, 0);
    let second = CopyArea::create_with_cache(&dir, Some(f.cache.clone()), 0).unwrap();
    assert!(path.exists());
    first.verify().unwrap();
    drop(second);
    drop(first);
    assert!(!path.exists());
}

#[test]
fn staging_for_a_copy_is_on_the_destination_filesystem() {
    let Some(second) = std::env::var_os("OARLOCK_TEST_SECOND_VOLUME") else {
        eprintln!("manual-only: set OARLOCK_TEST_SECOND_VOLUME to a separate writable filesystem");
        return;
    };
    let f = fixture();
    let other = tempfile::tempdir_in(second).unwrap();
    let dest = other.path().join("dest");
    let cache = other.path().join("cache");
    fs::create_dir(&dest).unwrap();
    fs::create_dir(&cache).unwrap();
    fs::set_permissions(&cache, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(f.src.join("file"), "across").unwrap();
    assert_ne!(
        fs::metadata(&f.src).unwrap().dev(),
        fs::metadata(&dest).unwrap().dev()
    );
    let dir = Dir::open_ambient_dir(&dest, cap_std::ambient_authority()).unwrap();
    let env = Env {
        dir: &dir,
        destination: &dest,
        rename_on_conflict: false,
        validate: &ok_validate,
        guard: &ok_guard,
        link_ok: &ok_link,
    };
    let source = f.src.join("file");
    let handle = open_source(&source).unwrap();
    let mut staged_dev = None;
    copy_item(&source, &handle, OsStr::new("file"), &env, &REAL, Some(cache.clone()), || {
        let area = fs::read_dir(cache.join("oarlock-staging")).unwrap().next().unwrap().unwrap();
        staged_dev = Some(fs::metadata(area.path()).unwrap().dev());
    })
    .unwrap();
    assert_eq!(staged_dev.unwrap(), fs::metadata(&dest).unwrap().dev());
    assert_eq!(fs::read(dest.join("file")).unwrap(), b"across");
}

#[test]
fn copying_a_repository_git_folder_into_itself_never_walks_into_its_own_staging() {
    let f = fixture();
    let repo = f.src.join("repo");
    fs::create_dir(&repo).unwrap();
    let init = std::process::Command::new("git")
        .args(["init", "-q"])
        .arg(&repo)
        .status()
        .unwrap();
    assert!(init.success());
    let git_dir = Dir::open_ambient_dir(repo.join(".git"), cap_std::ambient_authority()).unwrap();
    let env = Env {
        dir: &git_dir,
        destination: &repo.join(".git"),
        rename_on_conflict: true,
        validate: &ok_validate,
        guard: &ok_guard,
        link_ok: &ok_link,
    };
    let source = repo.join(".git");
    let handle = open_source(&source).unwrap();
    let name = copy_item(&source, &handle, OsStr::new(".git"), &env, &REAL, None, || {})
        .expect("a backup of .git inside the repository must succeed");
    let copy = repo.join(".git").join(&name);
    assert!(copy.join("HEAD").exists());
    assert!(!copy.join("oarlock-staging").exists(), "staging is not part of the copy");
}
