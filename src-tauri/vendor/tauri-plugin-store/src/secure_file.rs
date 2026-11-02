//! Directory-bound store access. Store aliases must never expose another file.
use std::{io, path::Path};

#[cfg(unix)]
fn open_dir(root: &Path, path: &Path, write: bool) -> io::Result<(std::fs::File, std::ffi::CString)> {
    use std::{ffi::CString, fs::{self, File, OpenOptions}, os::{fd::{AsRawFd, FromRawFd}, unix::{ffi::OsStrExt, fs::OpenOptionsExt}}, path::Component};
    let relative = path.strip_prefix(root).map_err(|_| io::Error::other("Store lies outside its data directory"))?;
    let parent = relative.parent().ok_or_else(|| io::Error::other("Store has no parent"))?;
    let name = CString::new(path.file_name().ok_or_else(|| io::Error::other("Store has no name"))?.as_bytes())
        .map_err(|_| io::Error::other("Invalid store name"))?;
    if write { fs::create_dir_all(root)?; }
    let mut dir = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC).open(root)?;
    for part in parent.components() {
        let Component::Normal(part) = part else { return Err(io::Error::other("Invalid store directory")); };
        let part = CString::new(part.as_bytes()).map_err(|_| io::Error::other("Invalid store directory"))?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mut fd = unsafe { libc::openat(dir.as_raw_fd(), part.as_ptr(), flags) };
        if fd < 0 && write && io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
            if unsafe { libc::mkdirat(dir.as_raw_fd(), part.as_ptr(), 0o700) } != 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::AlreadyExists { return Err(error); }
            }
            fd = unsafe { libc::openat(dir.as_raw_fd(), part.as_ptr(), flags) };
        }
        if fd < 0 { return Err(io::Error::last_os_error()); }
        dir = unsafe { File::from_raw_fd(fd) };
    }
    Ok((dir, name))
}

#[cfg(unix)]
fn open(root: &Path, path: &Path, write: bool) -> io::Result<std::fs::File> {
    use std::{fs::File, os::{fd::{AsRawFd, FromRawFd}, unix::fs::MetadataExt}};
    let (dir, name) = open_dir(root, path, write)?;
    let flags = if write { libc::O_WRONLY } else { libc::O_RDONLY } | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
    let mut fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 && write && io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
        fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags | libc::O_CREAT | libc::O_EXCL, 0o600) };
    }
    if fd < 0 { return Err(io::Error::last_os_error()); }
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(io::Error::other("Store must be a regular file with no hard-link aliases"));
    }
    let mut entry = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstatat(dir.as_raw_fd(), name.as_ptr(), entry.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let entry = unsafe { entry.assume_init() };
    if entry.st_dev as u64 != metadata.dev() || entry.st_ino != metadata.ino()
        || entry.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(io::Error::other("Store entry changed during open"));
    }
    Ok(file)
}

#[cfg(not(unix))]
fn open(_: &Path, _: &Path, _: bool) -> io::Result<std::fs::File> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "Safe store access is unavailable on this platform"))
}

pub fn read(root: &Path, path: &Path) -> io::Result<Vec<u8>> {
    use std::io::Read;
    let mut data = Vec::new();
    open(root, path, false)?.read_to_end(&mut data)?;
    Ok(data)
}

/// Replaces the store by staging the bytes in a private file beside it, flushing them and
/// renaming over the old entry, so a crash leaves the old or the new file, never a cut one.
/// The rename replaces a link itself instead of writing through it.
#[cfg(unix)]
pub fn write(root: &Path, path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::{fs::File, io::Write, os::fd::{AsRawFd, FromRawFd}, sync::atomic::{AtomicU64, Ordering}};
    static STAGED: AtomicU64 = AtomicU64::new(0);
    let (dir, name) = open_dir(root, path, true)?;
    let mut entry = std::mem::MaybeUninit::<libc::stat>::uninit();
    let found = unsafe { libc::fstatat(dir.as_raw_fd(), name.as_ptr(), entry.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } == 0;
    if found {
        let entry = unsafe { entry.assume_init() };
        if entry.st_mode & libc::S_IFMT != libc::S_IFREG || entry.st_nlink != 1 {
            return Err(io::Error::other("Store must be a regular file with no hard-link aliases"));
        }
    } else if io::Error::last_os_error().kind() != io::ErrorKind::NotFound {
        return Err(io::Error::last_os_error());
    }
    let staged = std::ffi::CString::new(format!(
        ".{}.{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        STAGED.fetch_add(1, Ordering::Relaxed)
    ))
    .map_err(|_| io::Error::other("Invalid store name"))?;
    let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let fd = unsafe { libc::openat(dir.as_raw_fd(), staged.as_ptr(), flags, 0o600) };
    if fd < 0 { return Err(io::Error::last_os_error()); }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let published = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        if unsafe { libc::renameat(dir.as_raw_fd(), staged.as_ptr(), dir.as_raw_fd(), name.as_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })();
    if published.is_err() {
        unsafe { libc::unlinkat(dir.as_raw_fd(), staged.as_ptr(), 0) };
        return published;
    }
    dir.sync_all()
}

#[cfg(not(unix))]
pub fn write(_: &Path, _: &Path, _: &[u8]) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "Safe store access is unavailable on this platform"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn refuses_symlink_and_hardlink_for_reads_and_writes() {
        let root = std::env::temp_dir().join(format!("oarlock-store-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir(&root).unwrap();
        let target = root.join("native.json");
        let link = root.join("alias.json");
        let hard = root.join("hard.json");
        fs::write(&target, b"original").unwrap();
        symlink(&target, &link).unwrap();
        fs::hard_link(&target, &hard).unwrap();
        for alias in [&link, &hard] {
            assert!(read(&root, alias).is_err());
            assert!(write(&root, alias, b"changed").is_err());
        }
        assert_eq!(fs::read(&target).unwrap(), b"original");
        fs::remove_file(&hard).unwrap();
        write(&root, &target, b"new").unwrap();
        assert_eq!(read(&root, &target).unwrap(), b"new");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_a_symlinked_parent_but_creates_normal_directories() {
        let root = std::env::temp_dir().join(format!("oarlock-parent-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("outside")).unwrap();
        fs::create_dir(root.join("data")).unwrap();
        symlink(root.join("outside"), root.join("data/windows")).unwrap();
        let data = root.join("data");
        let alias = data.join("windows/store.json");
        fs::write(root.join("outside/store.json"), b"keep").unwrap();
        assert!(read(&data, &alias).is_err());
        assert!(write(&data, &alias, b"changed").is_err());
        assert_eq!(fs::read(root.join("outside/store.json")).unwrap(), b"keep");
        let normal = data.join("normal/nested/store.json");
        write(&data, &normal, b"new").unwrap();
        assert_eq!(read(&data, &normal).unwrap(), b"new");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_save_replaces_the_file_whole_and_leaves_no_staging_file() {
        use std::io::Read;
        let root = std::env::temp_dir().join(format!("oarlock-atomic-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir(&root).unwrap();
        let target = root.join("oarlock-spaces.json");
        write(&root, &target, b"first").unwrap();
        let mut reader = fs::File::open(&target).unwrap();
        write(&root, &target, b"second, and longer").unwrap();
        let mut seen = String::new();
        reader.read_to_string(&mut seen).unwrap();
        assert_eq!(seen, "first", "a reader of the old file is not cut by the save");
        assert_eq!(read(&root, &target).unwrap(), b"second, and longer");
        let names: Vec<_> = fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["oarlock-spaces.json"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_save_keeps_the_old_file_and_removes_its_staging_file() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("oarlock-failed-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir(&root).unwrap();
        let target = root.join("store.json");
        write(&root, &target, b"kept").unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o500)).unwrap();
        let failed = write(&root, &target, b"lost");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        if failed.is_ok() {
            // Running as a user that ignores directory permissions (root): nothing to prove.
            fs::remove_dir_all(root).unwrap();
            return;
        }
        assert_eq!(fs::read(&target).unwrap(), b"kept");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_save_replaces_a_link_instead_of_writing_through_it() {
        let root = std::env::temp_dir().join(format!("oarlock-link-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir(&root).unwrap();
        let target = root.join("native.json");
        fs::write(&target, b"original").unwrap();
        let link = root.join("alias.json");
        symlink(&target, &link).unwrap();
        assert!(write(&root, &link, b"changed").is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
        fs::remove_dir_all(root).unwrap();
    }
}
