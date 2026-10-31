//! Directory-bound store access. Store aliases must never expose another file.
use std::{io, path::Path};

#[cfg(unix)]
fn open(path: &Path, write: bool) -> io::Result<std::fs::File> {
    use std::{ffi::CString, fs::File, os::{fd::{AsRawFd, FromRawFd}, unix::{ffi::OsStrExt, fs::MetadataExt}}};
    let parent = path.parent().ok_or_else(|| io::Error::other("Store has no parent"))?;
    let name = CString::new(path.file_name().ok_or_else(|| io::Error::other("Store has no name"))?.as_bytes())
        .map_err(|_| io::Error::other("Invalid store name"))?;
    let dir = File::open(parent)?;
    if !dir.metadata()?.is_dir() { return Err(io::Error::other("Store parent is not a directory")); }
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
fn open(_: &Path, _: bool) -> io::Result<std::fs::File> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "Safe store access is unavailable on this platform"))
}

pub fn read(path: &Path) -> io::Result<Vec<u8>> {
    use std::io::Read;
    let mut data = Vec::new();
    open(path, false)?.read_to_end(&mut data)?;
    Ok(data)
}

pub fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut file = open(path, true)?;
    file.set_len(0)?;
    file.write_all(bytes)
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
            assert!(read(alias).is_err());
            assert!(write(alias, b"changed").is_err());
        }
        assert_eq!(fs::read(&target).unwrap(), b"original");
        fs::remove_file(&hard).unwrap();
        write(&target, b"new").unwrap();
        assert_eq!(read(&target).unwrap(), b"new");
        fs::remove_dir_all(root).unwrap();
    }
}
