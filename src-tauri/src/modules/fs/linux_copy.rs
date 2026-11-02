//! Linux metadata-preserving copy. An item is copied entry by entry through
//! `O_NOFOLLOW` handles into a private staging area on the destination's mount
//! and published with a directory-relative `renameat2(RENAME_NOREPLACE)`.
use super::{
    access_control::{real_chown, AccessControl, CopyApplied},
    copy::{copy_name, MAX_COPY_SUFFIX},
    destination::sync_directory,
    linux_staging::{rename_noreplace_at, CopyArea},
};
use cap_std::fs::Dir;
use std::{
    ffi::{CString, OsStr, OsString},
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    os::{
        fd::{AsRawFd, FromRawFd, RawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Path, PathBuf},
};

const ITEM: &str = "item";
const MAX_DEPTH: usize = 128;
const CHUNK: usize = 1 << 30;
const FALLBACK_BUFFER: usize = 128 * 1024;

/// The system calls a test must be able to steer.
pub(super) struct Sys {
    pub copy_file_range: fn(RawFd, RawFd, usize) -> io::Result<usize>,
    pub chown: fn(&File, u32, u32) -> io::Result<()>,
    pub renameat2: fn(RawFd, &OsStr, RawFd, &OsStr) -> io::Result<()>,
}
fn real_copy_file_range(from: RawFd, to: RawFd, length: usize) -> io::Result<usize> {
    let copied = unsafe {
        libc::copy_file_range(from, std::ptr::null_mut(), to, std::ptr::null_mut(), length, 0)
    };
    if copied < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(copied as usize)
    }
}
pub(super) const REAL: Sys = Sys {
    copy_file_range: real_copy_file_range,
    chown: real_chown,
    renameat2: rename_noreplace_at,
};

/// Everything the copy needs from its caller.
pub(super) struct Env<'a> {
    pub dir: &'a Dir,
    pub destination: &'a Path,
    pub rename_on_conflict: bool,
    pub validate: &'a dyn Fn() -> io::Result<()>,
    pub guard: &'a dyn Fn(&Path) -> io::Result<()>,
    /// (source link, folder the link will sit in, destination of the copied item)
    pub link_ok: &'a dyn Fn(&Path, &Path, &Path) -> io::Result<()>,
}

fn cstr(name: &OsStr) -> io::Result<CString> {
    CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "File name contains NUL"))
}
fn from_fd(fd: RawFd) -> io::Result<File> {
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

/// Opens an entry without following a final link and without ever opening a
/// device, FIFO or socket: classify through `O_PATH`, then reopen only regular
/// files and folders. A link or special file comes back as the `O_PATH` handle.
fn open_entry(dir: RawFd, name: &CString) -> io::Result<File> {
    let held = from_fd(unsafe {
        libc::openat(dir, name.as_ptr(), libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC)
    })?;
    let metadata = held.metadata()?;
    let flags = if metadata.is_file() {
        libc::O_RDONLY
    } else if metadata.is_dir() {
        libc::O_RDONLY | libc::O_DIRECTORY
    } else {
        return Ok(held);
    };
    let through = CString::new(format!("/proc/self/fd/{}", held.as_raw_fd()))
        .map_err(io::Error::other)?;
    let file = from_fd(unsafe {
        libc::open(through.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOCTTY)
    })?;
    let reopened = file.metadata()?;
    if (reopened.dev(), reopened.ino()) != (metadata.dev(), metadata.ino()) {
        return Err(io::Error::other("Copy source changed while opening"));
    }
    Ok(file)
}
pub(super) fn open_source(path: &Path) -> io::Result<File> {
    open_entry(libc::AT_FDCWD, &cstr(path.as_os_str())?)
}

fn times_of(file: &File) -> io::Result<[libc::timespec; 2]> {
    let metadata = file.metadata()?;
    Ok([
        libc::timespec {
            tv_sec: metadata.atime(),
            tv_nsec: metadata.atime_nsec(),
        },
        libc::timespec {
            tv_sec: metadata.mtime(),
            tv_nsec: metadata.mtime_nsec(),
        },
    ])
}
fn set_times(file: &File, times: &[libc::timespec; 2]) {
    if unsafe { libc::futimens(file.as_raw_fd(), times.as_ptr()) } != 0 {
        log::debug!("Could not set copied times: {}", io::Error::last_os_error());
    }
}

/// Data is copied by the kernel while it makes progress, then by reading until
/// end of file; a short or zero return never ends the copy, and the size read
/// at the start is never the stop condition.
pub(super) fn copy_data(source: &File, target: &File, sys: &Sys) -> io::Result<()> {
    loop {
        match (sys.copy_file_range)(source.as_raw_fd(), target.as_raw_fd(), CHUNK) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(
                        libc::EXDEV
                            | libc::EINVAL
                            | libc::ENOSYS
                            | libc::EOPNOTSUPP
                            | libc::EPERM
                            | libc::EBADF
                    )
                ) =>
            {
                break
            }
            Err(error) => return Err(error),
        }
    }
    let mut buffer = vec![0u8; FALLBACK_BUFFER];
    let (mut source, mut target) = (source, target);
    loop {
        let read = source.read(&mut buffer)?;
        if read == 0 {
            return Ok(());
        }
        target.write_all(&buffer[..read])?;
    }
}

struct Walk<'a> {
    sys: &'a Sys,
    env: &'a Env<'a>,
    item_dest: PathBuf,
    /// `(dev, ino)` of the staging location holding this copy's own area: a copy of a
    /// folder that contains it (a repository's `.git`) must not walk into itself.
    skip: (u64, u64),
}
/// A folder published while still writable by its owner; `finish` gives it
/// its final mode, rules and times once it sits at its destination.
struct Deferred {
    dir: File,
    access: AccessControl,
    applied: CopyApplied,
    times: [libc::timespec; 2],
}
enum Staged {
    File(File),
    Link,
    Folder(Deferred),
}

fn refuse_privileged(mode: u32, directory: bool) -> io::Result<()> {
    let privileged = if directory { 0o4000 } else { 0o6000 };
    if mode & privileged != 0 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Copying files with setuid or setgid permissions is unsupported because they cannot be preserved safely",
        ));
    }
    Ok(())
}

fn stage_node(
    source: &File,
    source_path: &Path,
    area: RawFd,
    name: &OsStr,
    rel: &Path,
    depth: usize,
    walk: &Walk<'_>,
) -> io::Result<Staged> {
    let kind = source.metadata()?.file_type();
    if kind.is_file() {
        stage_file(source, area, name, walk).map(Staged::File)
    } else if kind.is_dir() {
        stage_folder(source, source_path, area, name, rel, depth, walk)
    } else if kind.is_symlink() {
        stage_link(source, source_path, area, name, rel, walk)?;
        Ok(Staged::Link)
    } else {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Copy folder contains an unsupported file type",
        ))
    }
}

fn stage_file(source: &File, area: RawFd, name: &OsStr, walk: &Walk<'_>) -> io::Result<File> {
    // A retry after a cross-mount error reads the same handle again.
    (&*source).seek(SeekFrom::Start(0))?;
    let times = times_of(source)?;
    let access = AccessControl::capture(source)?;
    refuse_privileged(access.mode(), false)?;
    let cname = cstr(name)?;
    let target = from_fd(unsafe {
        libc::openat(
            area,
            cname.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    })?;
    AccessControl::prepare_staging(&target)?;
    copy_data(source, &target, walk.sys)?;
    access.apply_for_copy(&target, &walk.sys.chown, false)?;
    set_times(&target, &times);
    Ok(target)
}

fn stage_link(
    source: &File,
    source_path: &Path,
    area: RawFd,
    name: &OsStr,
    rel: &Path,
    walk: &Walk<'_>,
) -> io::Result<()> {
    let mut buffer = vec![0u8; libc::PATH_MAX as usize];
    let length = unsafe {
        libc::readlinkat(
            source.as_raw_fd(),
            c"".as_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
        )
    };
    if length < 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize == buffer.len() {
        return Err(io::Error::other("Symbolic link target is too long"));
    }
    buffer.truncate(length as usize);
    // The item's own top-level link is copied verbatim; links inside a folder
    // must stay within the authorized folders where they will sit.
    if let Some(folder) = rel.parent().filter(|_| !rel.as_os_str().is_empty()) {
        (walk.env.link_ok)(source_path, &walk.item_dest.join(folder), &walk.item_dest)?;
    }
    let target = CString::new(buffer).map_err(io::Error::other)?;
    let cname = cstr(name)?;
    if unsafe { libc::symlinkat(target.as_ptr(), area, cname.as_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if let Ok(times) = times_of(source) {
        unsafe { libc::utimensat(area, cname.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
    }
    Ok(())
}

fn stage_folder(
    source: &File,
    source_path: &Path,
    area: RawFd,
    name: &OsStr,
    rel: &Path,
    depth: usize,
    walk: &Walk<'_>,
) -> io::Result<Staged> {
    if depth > MAX_DEPTH {
        return Err(io::Error::other("Copy folder exceeds maximum depth"));
    }
    let top = depth == 0;
    let times = times_of(source)?;
    let access = AccessControl::capture_directory(source)?;
    refuse_privileged(access.mode(), true)?;
    let cname = cstr(name)?;
    if unsafe { libc::mkdirat(area, cname.as_ptr(), 0o700) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let target = from_fd(unsafe {
        libc::openat(
            area,
            cname.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    })?;
    // A fresh open file description: a retry must list the folder from the start.
    let listing = from_fd(unsafe {
        libc::openat(
            source.as_raw_fd(),
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    })?;
    let children = Dir::from_std_file(listing);
    for entry in children.entries()? {
        let entry = entry?;
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(true);
        let child = entry.file_name();
        let handle = open_entry(source.as_raw_fd(), &cstr(&child)?)?;
        if is_dir {
            let meta = handle.metadata()?;
            if (meta.dev(), meta.ino()) == walk.skip {
                continue;
            }
        }
        // A name from a stale listing must still be the entry just opened.
        let path = source_path.join(&child);
        stage_node(
            &handle,
            &path,
            target.as_raw_fd(),
            &child,
            &rel.join(&child),
            depth + 1,
            walk,
        )?;
    }
    // Metadata goes on after the children so a read-only folder can be filled.
    // The item itself stays writable by its owner until it has been published:
    // moving a folder to another parent needs write permission on it.
    let applied = access.apply_for_copy(&target, &walk.sys.chown, top)?;
    if top {
        return Ok(Staged::Folder(Deferred {
            dir: target,
            access,
            applied,
            times,
        }));
    }
    set_times(&target, &times);
    Ok(Staged::Folder(Deferred {
        dir: target,
        access,
        applied,
        times,
    }))
}

fn publish(
    area: &CopyArea,
    env: &Env<'_>,
    sys: &Sys,
    name: &OsStr,
    folder: bool,
    item: Option<&File>,
) -> io::Result<OsString> {
    for n in 0..=MAX_COPY_SUFFIX {
        let target = if n == 0 {
            name.to_os_string()
        } else {
            copy_name(name, n, folder)
        };
        (env.validate)()?;
        (env.guard)(&env.destination.join(&target))?;
        area.verify()?;
        if let Some(item) = item {
            let held = area.dir()?;
            if !super::file_identity::entry_matches(&held, Path::new(ITEM), item)? {
                return Err(io::Error::other("Staged copy changed"));
            }
        }
        match (sys.renameat2)(area.fd(), OsStr::new(ITEM), env.dir.as_raw_fd(), &target) {
            Ok(()) => return Ok(target),
            Err(error)
                if error.kind() == io::ErrorKind::AlreadyExists && env.rename_on_conflict => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "No free copy name",
    ))
}

/// Copies `source` (already opened by `open_source`) into the destination
/// folder under `name`, or a free `name copy N` when asked to.
pub(super) fn copy_item(
    source: &Path,
    handle: &File,
    name: &OsStr,
    env: &Env<'_>,
    sys: &Sys,
    cache: Option<PathBuf>,
    before_publish: impl FnOnce(),
) -> io::Result<OsString> {
    let kind = handle.metadata()?.file_type();
    if !(kind.is_file() || kind.is_dir() || kind.is_symlink()) {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Unsupported copy source",
        ));
    }
    let mut before_publish = Some(before_publish);
    let mut from = 0;
    loop {
        let area = CopyArea::create_with_cache(env.dir, cache.clone(), from)?;
        let walk = Walk {
            sys,
            env,
            item_dest: env.destination.join(name),
            skip: area.location_id()?,
        };
        let staged = stage_node(
            handle,
            source,
            area.fd(),
            OsStr::new(ITEM),
            Path::new(""),
            0,
            &walk,
        )?;
        let item = match &staged {
            Staged::File(file) => Some(file),
            Staged::Folder(folder) => Some(&folder.dir),
            Staged::Link => None,
        };
        if unsafe { libc::syncfs(area.fd()) } != 0 {
            log::debug!("syncfs before publishing: {}", io::Error::last_os_error());
        }
        if let Some(hook) = before_publish.take() {
            hook();
        }
        match publish(&area, env, sys, name, kind.is_dir(), item) {
            Ok(target) => {
                if let Staged::Folder(folder) = &staged {
                    folder
                        .access
                        .finalize_for_copy(&folder.dir, &folder.applied)
                        .map_err(|error| {
                            io::Error::other(format!(
                                "Copied as {}, but its permissions could not be set: {error}",
                                target.to_string_lossy()
                            ))
                        })?;
                    set_times(&folder.dir, &folder.times);
                }
                if let Err(error) = sync_directory(env.dir) {
                    log::warn!("Copied but could not sync the folder: {error}");
                }
                return Ok(target);
            }
            // A bind mount shares the device but not the mount: restage elsewhere.
            Err(error) if error.raw_os_error() == Some(libc::EXDEV) => {
                from = area.next_location();
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
#[path = "linux_copy_tests.rs"]
mod tests;
