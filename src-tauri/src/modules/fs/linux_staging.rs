//! Linux unnamed save candidates, private copy areas and bounded, opportunistic
//! cleanup. Every staged byte lives under a 0700 directory owned by the user.
use super::{access_control::AccessControl, attachment::handle_path, file_identity::entry_matches};
use cap_std::fs::{Dir, DirBuilder, MetadataExt as _};
use std::{
    ffi::{CString, OsStr, OsString},
    fs::{self, File},
    io,
    os::{
        fd::{AsRawFd, FromRawFd, RawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, PermissionsExt},
        },
    },
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

const STAGING: &str = "oarlock-staging";
const DEST_STAGING: &str = ".oarlock-staging";
const MIN_AGE: Duration = Duration::from_secs(60);
pub(super) const MAX_CLEANUP_ENTRIES: usize = 4096;
const MAX_TREE_DEPTH: usize = 256;

fn c_name(name: &OsStr) -> io::Result<CString> {
    CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "File name contains NUL"))
}
fn unnamed(directory: &Dir, mode: u32) -> io::Result<File> {
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            c".".as_ptr(),
            libc::O_TMPFILE | libc::O_RDWR | libc::O_CLOEXEC,
            mode,
        )
    };
    if fd < 0 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("O_TMPFILE is unavailable: {}", io::Error::last_os_error()),
        ));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn link_file(file: &File, directory: &Dir, name: &OsStr) -> io::Result<()> {
    let name = c_name(name)?;
    if unsafe {
        libc::linkat(
            file.as_raw_fd(),
            c"".as_ptr(),
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::AT_EMPTY_PATH,
        )
    } == 0
    {
        return Ok(());
    }
    let first = io::Error::last_os_error();
    if !matches!(first.raw_os_error(), Some(libc::EPERM | libc::ENOENT)) {
        return Err(first);
    }
    let proc_path =
        CString::new(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(io::Error::other)?;
    if unsafe {
        libc::linkat(
            libc::AT_FDCWD,
            proc_path.as_ptr(),
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::AT_SYMLINK_FOLLOW,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
fn random_hex() -> io::Result<u128> {
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    Ok(u128::from_le_bytes(random))
}
fn name() -> io::Result<OsString> {
    Ok(format!("{}-{:032x}.tmp", std::process::id(), random_hex()?).into())
}
fn is_pid_and_random(text: &str) -> bool {
    let Some((pid, random)) = text.split_once('-') else {
        return false;
    };
    !pid.is_empty()
        && pid.len() <= 10
        && pid.bytes().all(|b| b.is_ascii_digit())
        && random.len() == 32
        && random
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn is_ours(name: &OsStr) -> bool {
    name.to_str()
        .and_then(|name| name.strip_suffix(".tmp"))
        .is_some_and(is_pid_and_random)
}
fn is_copy_area(name: &OsStr) -> bool {
    name.to_str()
        .and_then(|name| name.strip_prefix("copy-"))
        .and_then(|name| name.strip_suffix(".d"))
        .is_some_and(is_pid_and_random)
}

fn open_path(parent: RawFd, name: &OsStr) -> io::Result<File> {
    let cname = c_name(name)?;
    let fd = unsafe {
        libc::openat(
            parent,
            cname.as_ptr(),
            libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn proc_path(file: &File) -> io::Result<CString> {
    CString::new(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(io::Error::other)
}
/// Removes a staged tree we own. A staged folder may be read-only (its source
/// was), so each directory is made 0700 first; the private area protects it.
pub(super) fn remove_tree(parent: &Dir, name: &OsStr) -> io::Result<()> {
    remove_tree_at(parent.as_raw_fd(), name, 0)
}
fn remove_tree_at(parent: RawFd, name: &OsStr, depth: usize) -> io::Result<()> {
    if depth > MAX_TREE_DEPTH {
        return Err(io::Error::other("Staged tree is too deep to remove"));
    }
    let cname = c_name(name)?;
    let held = open_path(parent, name)?;
    let metadata = held.metadata()?;
    if !metadata.is_dir() {
        if unsafe { libc::unlinkat(parent, cname.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        return Ok(());
    }
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::other("Staged folder has a different owner"));
    }
    let procfs = proc_path(&held)?;
    if unsafe { libc::chmod(procfs.as_ptr(), 0o700) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = unsafe {
        libc::open(
            procfs.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let dir = unsafe { File::from_raw_fd(fd) };
    let entries = Dir::from_std_file(dir.try_clone()?);
    for entry in entries.entries()? {
        remove_tree_at(dir.as_raw_fd(), &entry?.file_name(), depth + 1)?;
    }
    if unsafe { libc::unlinkat(parent, cname.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn cleanup(directory: &Dir) -> io::Result<()> {
    cleanup_with_cap(directory, MAX_CLEANUP_ENTRIES)
}
fn cleanup_with_cap(directory: &Dir, cap: usize) -> io::Result<()> {
    for (seen, entry) in directory.entries()?.enumerate() {
        if seen >= cap {
            log::debug!("Staging cleanup stopped at {cap} entries");
            break;
        }
        let entry = entry?;
        let name = entry.file_name();
        let copy_area = is_copy_area(&name);
        if !copy_area && !is_ours(&name) {
            continue;
        }
        let Ok(kind) = directory.symlink_metadata(&name) else {
            continue;
        };
        if copy_area != kind.is_dir() || (!copy_area && !kind.is_file()) {
            continue;
        }
        let cname = c_name(&name)?;
        let mut fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                cname.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 && io::Error::last_os_error().kind() == io::ErrorKind::PermissionDenied {
            fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    cname.as_ptr(),
                    libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                )
            };
        }
        if fd < 0 {
            continue;
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = match file.metadata() {
            Ok(value)
                if (value.is_file() || value.is_dir()) && value.uid() == unsafe { libc::geteuid() } =>
            {
                value
            }
            _ => continue,
        };
        let old = metadata
            .modified()
            .ok()
            .and_then(|time| SystemTime::now().duration_since(time).ok())
            .is_some_and(|age| age >= MIN_AGE);
        if !old || unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            continue;
        }
        if entry_matches(directory, Path::new(&name), &file).unwrap_or(false) {
            let removed = if copy_area {
                remove_tree(directory, &name)
            } else {
                directory.remove_file(&name)
            };
            if let Err(error) = removed {
                log::warn!("Could not remove stale staging entry: {error}");
            }
        }
    }
    Ok(())
}

// Never run Git or follow a repository-supplied symlink while discovering it.
fn common_dir(directory: &Path) -> io::Result<Option<Option<PathBuf>>> {
    for root in directory.ancestors() {
        let marker = root.join(".git");
        let meta = match fs::symlink_metadata(&marker) {
            Ok(value) => value,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if !meta.is_file() && !meta.is_dir() {
            return Ok(Some(None));
        }
        let Ok((git, common)) = crate::modules::git::ownership::layout(root, false) else {
            return Ok(Some(None));
        };
        let contained = git.starts_with(root) && common.starts_with(root);
        let linked = !contained
            && crate::modules::git::ownership::reciprocal_worktree(root, &git, &common)
                .unwrap_or(false);
        return Ok(Some(if contained || linked {
            Some(common)
        } else {
            None
        }));
    }
    Ok(None)
}

// `st_dev` matches across bind mounts, where link and rename still fail with
// EXDEV, so the mount id decides when the kernel reports one.
fn mount_key(fd: RawFd) -> io::Result<(u64, Option<u64>)> {
    const STATX_MNT_ID: u32 = 0x1000;
    let mut stat: libc::statx = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::statx(
            fd,
            c"".as_ptr(),
            libc::AT_EMPTY_PATH,
            libc::STATX_BASIC_STATS | STATX_MNT_ID,
            &mut stat,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    let dev = libc::makedev(stat.stx_dev_major, stat.stx_dev_minor);
    Ok((
        dev,
        (stat.stx_mask & STATX_MNT_ID != 0).then_some(stat.stx_mnt_id),
    ))
}
fn same_mount(destination: &Dir, candidate: &Dir) -> io::Result<bool> {
    let (a, b) = (
        mount_key(destination.as_raw_fd())?,
        mount_key(candidate.as_raw_fd())?,
    );
    Ok(a.0 == b.0 && (a.1.is_none() || b.1.is_none() || a.1 == b.1))
}
fn private_child(parent: &Dir, child: &str) -> io::Result<Dir> {
    let mut builder = DirBuilder::new();
    use cap_std::fs::DirBuilderExt;
    builder.mode(0o700);
    let created = match parent.create_dir_with(child, &builder) {
        Ok(()) => true,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => false,
        Err(error) => return Err(error),
    };
    if !parent.symlink_metadata(child)?.is_dir() {
        return Err(io::Error::other("Staging path is not a directory"));
    }
    // cap-std directory handles may be O_PATH; ACL xattrs require a readable
    // directory descriptor, opened without following a substituted symlink.
    let cchild = CString::new(child).map_err(io::Error::other)?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            cchild.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let identity = unsafe { File::from_raw_fd(fd) };
    let dir = Dir::from_std_file(identity.try_clone()?);
    if !entry_matches(parent, Path::new(child), &identity)? {
        return Err(io::Error::other("Staging directory changed"));
    }
    let metadata = identity.metadata()?;
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::other("Staging directory has a different owner"));
    }
    if created {
        AccessControl::privatize_directory(&identity)?;
    } else if metadata.permissions().mode() & 0o7777 != 0o700 {
        return Err(io::Error::other("Staging directory is not private"));
    }
    Ok(dir)
}
fn cache_location(destination: &Dir, cache: Option<&Path>) -> io::Result<Dir> {
    let unavailable = || {
        io::Error::new(
            io::ErrorKind::Unsupported,
            "No private same-filesystem staging directory is available outside the Git worktree",
        )
    };
    let cache = cache.ok_or_else(unavailable)?;
    let parent = match Dir::open_ambient_dir(cache, cap_std::ambient_authority()) {
        Ok(parent) => parent,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(cache)?;
            Dir::open_ambient_dir(cache, cap_std::ambient_authority())?
        }
        Err(error) => return Err(error),
    };
    let metadata = parent.dir_metadata()?;
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Cache directory is not privately controlled",
        ));
    }
    if !same_mount(destination, &parent)?
        || super::private_staging::outside_worktrees(&parent.try_clone()?.into_std_file())
            .is_err()
    {
        return Err(unavailable());
    }
    private_child(&parent, STAGING)
}

#[derive(Clone, Debug)]
enum Location {
    Common(PathBuf),
    Cache(Option<PathBuf>),
    DestinationChild,
}
fn locations(destination: &Dir, cache: Option<&Path>) -> io::Result<Vec<Location>> {
    let actual =
        handle_path(&destination.try_clone()?.into_std_file()).map_err(io::Error::other)?;
    let cache = Location::Cache(cache.map(Path::to_path_buf));
    Ok(match common_dir(&actual)? {
        // No repository: the user's cache, then a private child of the folder.
        None => vec![cache, Location::DestinationChild],
        // A foreign or escaping `.git`: never inside the worktree (Review 76).
        Some(None) => vec![cache],
        Some(Some(common)) => vec![Location::Common(common), cache],
    })
}
fn open_location(destination: &Dir, location: &Location) -> io::Result<Dir> {
    match location {
        Location::Common(common) => {
            let parent = Dir::open_ambient_dir(common, cap_std::ambient_authority())?;
            if !same_mount(destination, &parent)? {
                return Err(io::Error::from(io::ErrorKind::Unsupported));
            }
            private_child(&parent, STAGING)
        }
        Location::Cache(path) => cache_location(destination, path.as_deref()),
        Location::DestinationChild => private_child(destination, DEST_STAGING),
    }
}
/// First usable location at or after `from`; the error is the last refusal.
fn select(
    destination: &Dir,
    locations: &[Location],
    from: usize,
) -> io::Result<(usize, Dir)> {
    let mut last = io::Error::new(
        io::ErrorKind::Unsupported,
        "No private same-filesystem staging directory is available outside the Git worktree",
    );
    for (index, location) in locations.iter().enumerate().skip(from) {
        match open_location(destination, location) {
            Ok(dir) => return Ok((index, dir)),
            Err(error) => last = error,
        }
    }
    Err(last)
}
fn remove_destination_child(destination: &Dir) {
    let _ = destination.remove_dir(DEST_STAGING);
}
/// A crash can leave entries in a `.oarlock-staging`; when a better location is
/// chosen later, nothing else would ever clear it. Only a private folder of ours
/// is swept, and it is removed once empty.
fn sweep_stale_destination_child(destination: &Dir, locations: &[Location], chosen: usize) {
    let has_child = locations
        .iter()
        .any(|location| matches!(location, Location::DestinationChild));
    if !has_child || matches!(locations[chosen], Location::DestinationChild) {
        return;
    }
    if !matches!(destination.symlink_metadata(DEST_STAGING), Ok(meta) if meta.is_dir()) {
        return;
    }
    if let Ok(stale) = private_child(destination, DEST_STAGING) {
        let _ = cleanup(&stale);
        remove_destination_child(destination);
    }
}

pub(super) struct Candidate {
    file: File,
    staging: Dir,
    destination: Dir,
    locations: Vec<Location>,
    index: usize,
    linked: Option<OsString>,
}
impl Candidate {
    pub fn create(destination: &Dir) -> io::Result<Self> {
        Self::create_with_cache(destination, dirs::cache_dir())
    }
    fn create_with_cache(destination: &Dir, cache: Option<PathBuf>) -> io::Result<Self> {
        let locations = locations(destination, cache.as_deref())?;
        let (index, staging) = select(destination, &locations, 0)?;
        sweep_stale_destination_child(destination, &locations, index);
        cleanup(&staging)?;
        let file = unnamed(destination, 0o600)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        AccessControl::prepare_staging(&file)?;
        Ok(Self {
            file,
            staging,
            destination: destination.try_clone()?,
            locations,
            index,
            linked: None,
        })
    }
    pub fn file(&self) -> &File {
        &self.file
    }
    pub fn verify(&self) -> io::Result<()> {
        let metadata = self.file.metadata()?;
        if !metadata.is_file() || (self.linked.is_none() && metadata.nlink() != 0) {
            return Err(io::Error::other("Unnamed staging file changed"));
        }
        if let Some(name) = &self.linked {
            if !entry_matches(&self.staging, Path::new(name), &self.file)? {
                return Err(io::Error::other("Staging entry changed"));
            }
        }
        Ok(())
    }
    pub fn inheritance_from(&self, destination: &Dir) -> io::Result<AccessControl> {
        let probe = unnamed(destination, 0o666)?;
        AccessControl::capture(&probe)
    }
    pub fn publish(&mut self, destination: &Dir, target: &OsStr, replace: bool) -> io::Result<()> {
        self.verify()?;
        if !replace {
            return link_file(&self.file, destination, target);
        }
        let mut attempts = 0;
        loop {
            attempts += 1;
            match self.link_and_rename(destination, target) {
                // A bind mount shares `st_dev` but not the mount: stage elsewhere.
                Err(error)
                    if error.raw_os_error() == Some(libc::EXDEV)
                        && attempts <= self.locations.len() =>
                {
                    let (index, staging) =
                        select(&self.destination, &self.locations, self.index + 1)?;
                    cleanup(&staging)?;
                    self.index = index;
                    self.staging = staging;
                }
                other => return other,
            }
        }
    }
    fn link_and_rename(&mut self, destination: &Dir, target: &OsStr) -> io::Result<()> {
        let mut reopened = false;
        let mut collisions = 0;
        while self.linked.is_none() {
            let candidate = name()?;
            match link_file(&self.file, &self.staging, &candidate) {
                Ok(()) => self.linked = Some(candidate),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists && collisions < 8 => {
                    collisions += 1;
                }
                // A concurrent save removed the empty folder after its own publish.
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound
                        && !reopened
                        && matches!(self.locations[self.index], Location::DestinationChild) =>
                {
                    reopened = true;
                    self.staging = private_child(&self.destination, DEST_STAGING)?;
                }
                Err(error) => return Err(error),
            }
        }
        let name = self
            .linked
            .clone()
            .ok_or_else(|| io::Error::other("Cannot allocate staging name"))?;
        self.verify()?;
        match self.staging.rename(&name, destination, target) {
            Ok(()) => {
                self.linked = None;
                Ok(())
            }
            Err(error) => {
                self.remove_linked();
                Err(error)
            }
        }
    }
    fn remove_linked(&mut self) {
        if let Some(name) = self.linked.take() {
            if entry_matches(&self.staging, Path::new(&name), &self.file).unwrap_or(false) {
                if let Err(error) = self.staging.remove_file(&name) {
                    log::warn!("Could not remove staging file: {error}");
                }
            }
        }
    }
}
impl Drop for Candidate {
    fn drop(&mut self) {
        self.remove_linked();
        if matches!(self.locations[self.index], Location::DestinationChild) {
            remove_destination_child(&self.destination);
        }
    }
}

/// A per-operation 0700 folder in a private staging location, locked for the
/// operation's lifetime so the stale sweep never removes a live copy.
pub(super) struct CopyArea {
    parent: Dir,
    name: OsString,
    area: File,
    destination: Dir,
    locations: Vec<Location>,
    index: usize,
}
impl CopyArea {
    pub fn create_with_cache(
        destination: &Dir,
        cache: Option<PathBuf>,
        from: usize,
    ) -> io::Result<Self> {
        let locations = locations(destination, cache.as_deref())?;
        let (index, parent) = select(destination, &locations, from)?;
        sweep_stale_destination_child(destination, &locations, index);
        cleanup(&parent)?;
        let name = OsString::from(format!(
            "copy-{}-{:032x}.d",
            std::process::id(),
            random_hex()?
        ));
        let mut builder = DirBuilder::new();
        use cap_std::fs::DirBuilderExt;
        builder.mode(0o700);
        parent.create_dir_with(&name, &builder)?;
        let cname = c_name(&name)?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                cname.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let area = unsafe { File::from_raw_fd(fd) };
        let this = Self {
            parent,
            name,
            area,
            destination: destination.try_clone()?,
            locations,
            index,
        };
        if unsafe { libc::flock(this.area.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        AccessControl::privatize_directory(&this.area)?;
        this.verify()?;
        Ok(this)
    }
    /// `(dev, ino)` of the staging location folder that holds this area.
    pub fn location_id(&self) -> io::Result<(u64, u64)> {
        let meta = self.parent.dir_metadata()?;
        Ok((meta.dev(), meta.ino()))
    }
    /// The location a retry after `EXDEV` must start from.
    pub fn next_location(&self) -> usize {
        self.index + 1
    }
    pub fn fd(&self) -> RawFd {
        self.area.as_raw_fd()
    }
    pub fn dir(&self) -> io::Result<Dir> {
        Ok(Dir::from_std_file(self.area.try_clone()?))
    }
    pub fn verify(&self) -> io::Result<()> {
        if !entry_matches(&self.parent, Path::new(&self.name), &self.area)? {
            return Err(io::Error::other("Copy staging folder changed"));
        }
        Ok(())
    }
}
impl Drop for CopyArea {
    fn drop(&mut self) {
        if let Err(error) = remove_tree(&self.parent, &self.name) {
            log::warn!("Could not remove copy staging folder: {error}");
        }
        if matches!(self.locations[self.index], Location::DestinationChild) {
            remove_destination_child(&self.destination);
        }
    }
}

/// `RENAME_NOREPLACE` through directory descriptors; a filesystem that does
/// not implement it (EINVAL) is a refusal, never a replacing rename.
pub(super) fn rename_noreplace_at(
    from_dir: RawFd,
    from: &OsStr,
    to_dir: RawFd,
    to: &OsStr,
) -> io::Result<()> {
    let (from, to) = (c_name(from)?, c_name(to)?);
    if unsafe {
        libc::renameat2(
            from_dir,
            from.as_ptr(),
            to_dir,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } == 0
    {
        return Ok(());
    }
    Err(noreplace_error(io::Error::last_os_error()))
}
/// EINVAL means the filesystem cannot publish without replacing: a refusal.
pub(super) fn noreplace_error(error: io::Error) -> io::Error {
    if error.raw_os_error() == Some(libc::EINVAL) {
        return io::Error::new(
            io::ErrorKind::Unsupported,
            "This filesystem cannot publish without replacing (RENAME_NOREPLACE); nothing was copied",
        );
    }
    error
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::{io::Write, process::Command};

    pub(crate) fn test_dir() -> tempfile::TempDir {
        match std::env::var_os("OARLOCK_TEST_PRIMARY_VOLUME") {
            Some(path) => tempfile::tempdir_in(path).unwrap(),
            None => tempfile::tempdir().unwrap(),
        }
    }
    fn open_dir(path: &Path) -> Dir {
        Dir::open_ambient_dir(path, cap_std::ambient_authority()).unwrap()
    }
    fn git(root: &Path, args: &[&str]) -> String {
        let result = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8(result.stdout).unwrap()
    }
    fn old(path: &Path) {
        use std::os::unix::ffi::OsStrExt;
        let name = CString::new(path.as_os_str().as_bytes()).unwrap();
        let times = [libc::timespec {
            tv_sec: 1,
            tv_nsec: 0,
        }; 2];
        assert_eq!(
            unsafe { libc::utimensat(libc::AT_FDCWD, name.as_ptr(), times.as_ptr(), 0) },
            0
        );
    }
    fn lock(path: &Path) -> File {
        let held = File::open(path).unwrap();
        assert_eq!(
            unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        held
    }
    fn staging_path(candidate: &Candidate) -> PathBuf {
        handle_path(&candidate.staging.try_clone().unwrap().into_std_file()).unwrap()
    }
    fn private_cache(root: &Path) -> PathBuf {
        let cache = root.join("cache");
        fs::create_dir(&cache).unwrap();
        fs::set_permissions(&cache, fs::Permissions::from_mode(0o700)).unwrap();
        cache
    }

    #[test]
    fn cleanup_removes_only_old_unlocked_regular_matching_entries() {
        let root = test_dir();
        let dir = open_dir(root.path());
        let stale = "123-00000000000000000000000000000001.tmp";
        let live = "123-00000000000000000000000000000002.tmp";
        let recent = "123-00000000000000000000000000000003.tmp";
        let link = "123-00000000000000000000000000000004.tmp";
        for name in [stale, live, recent, "unrelated.tmp"] {
            fs::write(root.path().join(name), name).unwrap();
        }
        old(&root.path().join(stale));
        old(&root.path().join(live));
        old(&root.path().join("unrelated.tmp"));
        std::os::unix::fs::symlink(root.path().join("unrelated.tmp"), root.path().join(link))
            .unwrap();
        let _held = lock(&root.path().join(live));
        cleanup(&dir).unwrap();
        assert!(!root.path().join(stale).exists());
        for name in [live, recent, "unrelated.tmp", link] {
            assert!(
                fs::symlink_metadata(root.path().join(name)).is_ok(),
                "{name}"
            );
        }
    }
    #[test]
    fn cleanup_stops_at_the_entry_cap_without_error() {
        let root = test_dir();
        let dir = open_dir(root.path());
        for n in 0..12 {
            let path = root.path().join(format!("123-{n:032x}.tmp"));
            fs::write(&path, "old").unwrap();
            old(&path);
        }
        cleanup_with_cap(&dir, 5).unwrap();
        let left = fs::read_dir(root.path()).unwrap().count();
        assert_eq!(left, 7);
        // The cap bounds the entries examined, not the cleanup itself.
        cleanup_with_cap(&dir, usize::MAX).unwrap();
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }
    #[test]
    fn remove_tree_empties_read_only_nested_folders() {
        let root = test_dir();
        let dir = open_dir(root.path());
        let nested = root.path().join("tree/a/b");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("file"), "x").unwrap();
        std::os::unix::fs::symlink("file", nested.join("link")).unwrap();
        for folder in ["tree/a/b", "tree/a", "tree"] {
            fs::set_permissions(root.path().join(folder), fs::Permissions::from_mode(0o555))
                .unwrap();
        }
        remove_tree(&dir, OsStr::new("tree")).unwrap();
        assert!(!root.path().join("tree").exists());
    }
    #[test]
    fn stale_copy_areas_are_swept_and_live_ones_are_kept() {
        let root = test_dir();
        let dir = open_dir(root.path());
        let stale = root.path().join("copy-1-00000000000000000000000000000001.d");
        let live = root.path().join("copy-1-00000000000000000000000000000002.d");
        for area in [&stale, &live] {
            fs::create_dir_all(area.join("nested")).unwrap();
            fs::write(area.join("nested/file"), "x").unwrap();
            fs::set_permissions(area.join("nested"), fs::Permissions::from_mode(0o555)).unwrap();
        }
        // The age check reads the area's own time; nested changes would not move it.
        old(&stale);
        old(&live);
        let _held = lock(&live);
        cleanup(&dir).unwrap();
        assert!(!stale.exists());
        assert!(live.exists());
        fs::set_permissions(live.join("nested"), fs::Permissions::from_mode(0o700)).unwrap();
    }
    #[test]
    fn repository_staging_is_private_to_git_and_invisible_to_status() {
        let root = test_dir();
        if std::env::var_os("OARLOCK_TEST_PRIMARY_VOLUME").is_some() {
            assert_ne!(
                fs::metadata(root.path()).unwrap().dev(),
                fs::metadata(std::env::temp_dir()).unwrap().dev()
            );
        }
        git(root.path(), &["init", "-q"]);
        fs::write(root.path().join(".gitignore"), ".env\n").unwrap();
        fs::write(root.path().join(".env"), "original").unwrap();
        let dir = open_dir(root.path());
        let mut candidate = Candidate::create(&dir).unwrap();
        assert!(staging_path(&candidate).starts_with(root.path().join(".git")));
        candidate.file().write_all(b"secret draft").unwrap();
        let pending = name().unwrap();
        link_file(candidate.file(), &candidate.staging, &pending).unwrap();
        candidate.linked = Some(pending);
        let status = git(
            root.path(),
            &["status", "--porcelain", "--untracked-files=all"],
        );
        assert!(
            !status.contains("oarlock-staging") && !status.contains("secret"),
            "{status}"
        );
        git(root.path(), &["add", "--all"]);
        assert_eq!(
            git(root.path(), &["diff", "--cached", "--name-only"]).trim(),
            ".gitignore"
        );
        drop(candidate);
        let mut candidate = Candidate::create(&dir).unwrap();
        candidate.file().write_all(b"updated").unwrap();
        candidate.publish(&dir, OsStr::new(".env"), true).unwrap();
        assert_eq!(fs::read(root.path().join(".env")).unwrap(), b"updated");
    }
    #[test]
    fn non_repository_stages_privately_and_never_in_the_users_directory() {
        let root = test_dir();
        let cache = private_cache(root.path());
        let work = root.path().join("work");
        fs::create_dir(&work).unwrap();
        fs::write(work.join("document"), "old").unwrap();
        let dir = open_dir(&work);
        let mut candidate = Candidate::create_with_cache(&dir, Some(cache.clone())).unwrap();
        assert!(staging_path(&candidate).starts_with(&cache));
        candidate.file().write_all(b"new").unwrap();
        candidate
            .publish(&dir, OsStr::new("document"), true)
            .unwrap();
        assert_eq!(fs::read(work.join("document")).unwrap(), b"new");
        let names: Vec<_> = fs::read_dir(&work).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![OsString::from("document")]);
    }
    #[test]
    fn crash_between_link_and_rename_leaves_nothing_in_the_users_directory() {
        let root = test_dir();
        let cache = private_cache(root.path());
        let work = root.path().join("work");
        fs::create_dir(&work).unwrap();
        let dir = open_dir(&work);
        let candidate = Candidate::create_with_cache(&dir, Some(cache.clone())).unwrap();
        candidate.file().write_all(b"secret draft").unwrap();
        candidate
            .file()
            .set_permissions(fs::Permissions::from_mode(0o644))
            .unwrap();
        let pending = name().unwrap();
        link_file(candidate.file(), &candidate.staging, &pending).unwrap();
        let staging = staging_path(&candidate);
        std::mem::forget(candidate);
        assert_eq!(fs::read_dir(&work).unwrap().count(), 0);
        let mode = fs::metadata(&staging).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o700);
        assert!(staging.join(&pending).exists());
        assert!(staging.starts_with(&cache));
    }
    #[test]
    fn a_missing_cache_directory_is_created_private() {
        let root = test_dir();
        let cache = root.path().join("fresh/cache");
        let work = root.path().join("work");
        fs::create_dir(&work).unwrap();
        let dir = open_dir(&work);
        let candidate = Candidate::create_with_cache(&dir, Some(cache.clone())).unwrap();
        assert!(staging_path(&candidate).starts_with(&cache));
        let mode = fs::metadata(&cache).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o700);
    }
    #[test]
    fn a_stale_destination_child_is_swept_once_the_cache_is_usable() {
        let root = test_dir();
        let work = root.path().join("work");
        let cache = root.path().join("cache");
        for dir in [&work, &cache] {
            fs::create_dir(dir).unwrap();
        }
        fs::set_permissions(&cache, fs::Permissions::from_mode(0o700)).unwrap();
        let child = work.join(".oarlock-staging");
        fs::create_dir(&child).unwrap();
        fs::set_permissions(&child, fs::Permissions::from_mode(0o700)).unwrap();
        let leftover = child.join("123-00000000000000000000000000000001.tmp");
        fs::write(&leftover, "draft").unwrap();
        old(&leftover);
        let dir = open_dir(&work);
        let candidate = Candidate::create_with_cache(&dir, Some(cache.clone())).unwrap();
        assert_eq!(staging_path(&candidate), cache.join("oarlock-staging"));
        assert!(!child.exists(), "the stale folder and its draft are gone");
    }
    #[test]
    fn unusable_cache_falls_back_to_a_private_destination_child_removed_after_publish() {
        let root = test_dir();
        let work = root.path().join("work");
        fs::create_dir(&work).unwrap();
        fs::write(work.join("document"), "old").unwrap();
        let not_a_directory = root.path().join("cache-file");
        fs::write(&not_a_directory, "").unwrap();
        let dir = open_dir(&work);
        let mut candidate =
            Candidate::create_with_cache(&dir, Some(not_a_directory.clone())).unwrap();
        let staging = staging_path(&candidate);
        assert_eq!(staging, work.join(".oarlock-staging"));
        let mode = fs::metadata(&staging).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o700);
        candidate.file().write_all(b"new").unwrap();
        candidate
            .publish(&dir, OsStr::new("document"), true)
            .unwrap();
        drop(candidate);
        assert!(!work.join(".oarlock-staging").exists());
        assert_eq!(fs::read(work.join("document")).unwrap(), b"new");
    }
    #[test]
    fn a_non_empty_destination_child_is_left_in_place() {
        let root = test_dir();
        let work = root.path().join("work");
        fs::create_dir(&work).unwrap();
        let not_a_directory = root.path().join("cache-file");
        fs::write(&not_a_directory, "").unwrap();
        let dir = open_dir(&work);
        let candidate = Candidate::create_with_cache(&dir, Some(not_a_directory)).unwrap();
        fs::write(work.join(".oarlock-staging/other"), "keep").unwrap();
        drop(candidate);
        assert!(work.join(".oarlock-staging/other").exists());
    }
    #[test]
    fn a_foreign_git_marker_never_gets_a_destination_child_and_refuses_without_a_cache() {
        let root = test_dir();
        std::os::unix::fs::symlink("elsewhere", root.path().join(".git")).unwrap();
        let dir = open_dir(root.path());
        let error = Candidate::create_with_cache(&dir, None).err().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::Unsupported);
        assert!(!root.path().join(".oarlock-staging").exists());
        assert!(!root.path().join("oarlock-staging").exists());
    }
    #[test]
    fn same_mount_is_reflexive_and_distinguishes_volumes() {
        let root = test_dir();
        let dir = open_dir(root.path());
        assert!(same_mount(&dir, &dir).unwrap());
        if let Some(second) = std::env::var_os("OARLOCK_TEST_SECOND_VOLUME") {
            let other = tempfile::tempdir_in(second).unwrap();
            assert!(!same_mount(&dir, &open_dir(other.path())).unwrap());
        }
    }
    #[test]
    fn linked_worktree_with_cross_volume_common_dir_uses_cache_or_refuses() {
        let Some(second) = std::env::var_os("OARLOCK_TEST_SECOND_VOLUME") else {
            eprintln!(
                "manual-only: set OARLOCK_TEST_SECOND_VOLUME to a separate writable filesystem"
            );
            return;
        };
        let primary = test_dir();
        let other = tempfile::tempdir_in(second).unwrap();
        assert_ne!(
            fs::metadata(primary.path()).unwrap().dev(),
            fs::metadata(other.path()).unwrap().dev()
        );
        git(primary.path(), &["init", "-q"]);
        fs::write(primary.path().join("file.txt"), "old").unwrap();
        git(primary.path(), &["add", "file.txt"]);
        git(
            primary.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-qm",
                "initial",
            ],
        );
        let worktree = other.path().join("linked");
        git(
            primary.path(),
            &[
                "worktree",
                "add",
                "-qb",
                "test-link",
                worktree.to_str().unwrap(),
            ],
        );
        let cache = private_cache(other.path());
        let dir = open_dir(&worktree);
        assert!(Candidate::create_with_cache(&dir, None).is_err());
        let mut candidate = Candidate::create_with_cache(&dir, Some(cache.clone())).unwrap();
        assert!(staging_path(&candidate).starts_with(&cache));
        candidate.file().write_all(b"updated").unwrap();
        candidate
            .publish(&dir, OsStr::new("file.txt"), true)
            .unwrap();
        assert_eq!(fs::read(worktree.join("file.txt")).unwrap(), b"updated");
        assert!(!git(
            &worktree,
            &["status", "--porcelain", "--untracked-files=all"]
        )
        .contains("oarlock-staging"));
    }
    #[test]
    fn symlinked_git_staging_directory_is_never_followed() {
        let root = test_dir();
        let outside = test_dir();
        git(root.path(), &["init", "-q"]);
        fs::write(outside.path().join("keep"), "safe").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join(".git/oarlock-staging"))
            .unwrap();
        let dir = open_dir(root.path());
        assert!(Candidate::create_with_cache(&dir, None).is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join("keep")).unwrap(),
            "safe"
        );
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
    }
    #[test]
    fn substituted_named_entry_is_not_published_or_deleted() {
        let root = test_dir();
        git(root.path(), &["init", "-q"]);
        let dir = open_dir(root.path());
        let mut candidate = Candidate::create(&dir).unwrap();
        candidate.file().write_all(b"private draft").unwrap();
        let pending = name().unwrap();
        link_file(candidate.file(), &candidate.staging, &pending).unwrap();
        candidate.linked = Some(pending.clone());
        candidate.staging.remove_file(&pending).unwrap();
        fs::write(
            root.path().join(".git/oarlock-staging").join(&pending),
            "unrelated",
        )
        .unwrap();
        assert!(candidate.verify().is_err());
        drop(candidate);
        assert_eq!(
            fs::read(root.path().join(".git/oarlock-staging").join(&pending)).unwrap(),
            b"unrelated"
        );
    }

    #[test]
    fn substituted_symlink_and_fifo_are_not_opened_or_removed() {
        use std::os::unix::ffi::OsStrExt;
        let root = test_dir();
        let dir = open_dir(root.path());
        for fifo in [false, true] {
            let name = format!("123-{:032x}.tmp", usize::from(fifo));
            let path = root.path().join(&name);
            if fifo {
                let name = CString::new(path.as_os_str().as_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            } else {
                std::os::unix::fs::symlink("missing", &path).unwrap();
            }
            cleanup(&dir).unwrap();
            assert!(fs::symlink_metadata(&path).is_ok());
            fs::remove_file(path).unwrap();
        }
    }
    #[test]
    fn unsupported_unnamed_files_are_refused_with_a_reason() {
        let proc = open_dir(Path::new("/proc"));
        let error = unnamed(&proc, 0o600).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Unsupported);
        assert!(error.to_string().contains("O_TMPFILE"), "{error}");
    }
    #[test]
    fn noreplace_publication_keeps_an_existing_entry() {
        let root = test_dir();
        fs::create_dir(root.path().join("from")).unwrap();
        fs::create_dir(root.path().join("to")).unwrap();
        fs::write(root.path().join("from/item"), "new").unwrap();
        fs::write(root.path().join("to/item"), "old").unwrap();
        let (from, to) = (open_dir(&root.path().join("from")), open_dir(&root.path().join("to")));
        let error =
            rename_noreplace_at(from.as_raw_fd(), OsStr::new("item"), to.as_raw_fd(), OsStr::new("item"))
                .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(root.path().join("to/item")).unwrap(), b"old");
    }
}
