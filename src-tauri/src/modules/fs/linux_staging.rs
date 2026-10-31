//! Linux unnamed save candidates and bounded, opportunistic cleanup.
use super::{access_control::AccessControl, attachment::handle_path, file_identity::entry_matches};
use cap_std::fs::{Dir, DirBuilder, MetadataExt as _};
use std::{
    ffi::{CString, OsStr, OsString},
    fs::{self, File},
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, PermissionsExt},
        },
    },
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

const STAGING: &str = "oarlock-staging";
const MIN_AGE: Duration = Duration::from_secs(60);

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
fn name(hidden: bool) -> io::Result<OsString> {
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    Ok(format!(
        "{}{}-{:032x}.tmp",
        if hidden { "." } else { "" },
        std::process::id(),
        u128::from_le_bytes(random)
    )
    .into())
}
fn is_ours(name: &OsStr, hidden: bool) -> bool {
    let Some(mut name) = name.to_str() else {
        return false;
    };
    if hidden {
        let Some(stripped) = name.strip_prefix('.') else {
            return false;
        };
        name = stripped;
    }
    let Some(name) = name.strip_suffix(".tmp") else {
        return false;
    };
    let Some((pid, random)) = name.split_once('-') else {
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
fn cleanup(directory: &Dir, hidden: bool) -> io::Result<()> {
    for entry in directory.entries()? {
        let entry = entry?;
        let name = entry.file_name();
        if !is_ours(&name, hidden) {
            continue;
        }
        if !directory
            .symlink_metadata(&name)
            .is_ok_and(|metadata| metadata.is_file())
        {
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
            Ok(value) if value.is_file() && value.uid() == unsafe { libc::geteuid() } => value,
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
            if let Err(error) = directory.remove_file(&name) {
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
fn same_filesystem(destination: &Dir, candidate: &Dir) -> io::Result<bool> {
    Ok(destination.dir_metadata()?.dev() == candidate.dir_metadata()?.dev())
}
fn private_child(parent: &Dir) -> io::Result<Dir> {
    let mut builder = DirBuilder::new();
    use cap_std::fs::DirBuilderExt;
    builder.mode(0o700);
    let created = match parent.create_dir_with(STAGING, &builder) {
        Ok(()) => true,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => false,
        Err(error) => return Err(error),
    };
    if !parent.symlink_metadata(STAGING)?.is_dir() {
        return Err(io::Error::other("Staging path is not a directory"));
    }
    // cap-std directory handles may be O_PATH; ACL xattrs require a readable
    // directory descriptor, opened without following a substituted symlink.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            c"oarlock-staging".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let identity = unsafe { File::from_raw_fd(fd) };
    let dir = Dir::from_std_file(identity.try_clone()?);
    if !entry_matches(parent, Path::new(STAGING), &identity)? {
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
    if let Some(cache) = cache {
        if let Ok(parent) = Dir::open_ambient_dir(cache, cap_std::ambient_authority()) {
            let metadata = parent.dir_metadata()?;
            if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Cache directory is not privately controlled",
                ));
            }
            if same_filesystem(destination, &parent)?
                && super::private_staging::outside_worktrees(&parent.try_clone()?.into_std_file())
                    .is_ok()
            {
                if let Ok(dir) = private_child(&parent) {
                    return Ok(dir);
                }
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "No private same-filesystem staging directory is available outside the Git worktree",
    ))
}
fn location_with_cache(destination: &Dir, cache: Option<&Path>) -> io::Result<(Dir, bool)> {
    let actual =
        handle_path(&destination.try_clone()?.into_std_file()).map_err(io::Error::other)?;
    match common_dir(&actual)? {
        None => Ok((destination.try_clone()?, true)),
        Some(common) => {
            if let Some(common) = common {
                if let Ok(parent) = Dir::open_ambient_dir(&common, cap_std::ambient_authority()) {
                    if same_filesystem(destination, &parent)? {
                        if let Ok(dir) = private_child(&parent) {
                            return Ok((dir, false));
                        }
                    }
                }
            }
            Ok((cache_location(destination, cache)?, false))
        }
    }
}

pub(super) struct Candidate {
    file: File,
    staging: Dir,
    hidden: bool,
    linked: Option<OsString>,
    cache: Option<PathBuf>,
}
impl Candidate {
    pub fn create(destination: &Dir) -> io::Result<Self> {
        Self::create_with_cache(destination, dirs::cache_dir())
    }
    fn create_with_cache(destination: &Dir, cache: Option<PathBuf>) -> io::Result<Self> {
        let (staging, hidden) = location_with_cache(destination, cache.as_deref())?;
        cleanup(&staging, hidden)?;
        let file = unnamed(destination, 0o600)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        AccessControl::prepare_staging(&file)?;
        Ok(Self {
            file,
            staging,
            hidden,
            linked: None,
            cache,
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
        let mut fallback_attempted = false;
        for _ in 0..8 {
            let candidate = name(self.hidden)?;
            match link_file(&self.file, &self.staging, &candidate) {
                Ok(()) => {
                    self.linked = Some(candidate);
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error)
                    if error.raw_os_error() == Some(libc::EXDEV)
                        && !self.hidden
                        && !fallback_attempted =>
                {
                    self.staging = cache_location(destination, self.cache.as_deref())?;
                    cleanup(&self.staging, false)?;
                    fallback_attempted = true;
                }
                Err(error) => return Err(error),
            }
        }
        let name = self
            .linked
            .as_ref()
            .ok_or_else(|| io::Error::other("Cannot allocate staging name"))?;
        self.verify()?;
        self.staging.rename(name, destination, target)?;
        self.linked = None;
        Ok(())
    }
}
impl Drop for Candidate {
    fn drop(&mut self) {
        if let Some(name) = &self.linked {
            if entry_matches(&self.staging, Path::new(name), &self.file).unwrap_or(false) {
                if let Err(error) = self.staging.remove_file(name) {
                    log::warn!("Could not remove staging file: {error}");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, process::Command};

    fn test_dir() -> tempfile::TempDir {
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
        let held = File::open(root.path().join(live)).unwrap();
        assert_eq!(
            unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        cleanup(&dir, false).unwrap();
        assert!(!root.path().join(stale).exists());
        for name in [live, recent, "unrelated.tmp", link] {
            assert!(
                fs::symlink_metadata(root.path().join(name)).is_ok(),
                "{name}"
            );
        }
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
        assert!(!candidate.hidden);
        assert!(
            handle_path(&candidate.staging.try_clone().unwrap().into_std_file())
                .unwrap()
                .starts_with(root.path().join(".git"))
        );
        candidate.file().write_all(b"secret draft").unwrap();
        let pending = name(false).unwrap();
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
    fn non_repository_uses_hidden_sibling_and_cleans_stale_entries() {
        let root = test_dir();
        let dir = open_dir(root.path());
        let stale = ".123-00000000000000000000000000000001.tmp";
        fs::write(root.path().join(stale), "old").unwrap();
        old(&root.path().join(stale));
        let live = ".123-00000000000000000000000000000002.tmp";
        fs::write(root.path().join(live), "live").unwrap();
        old(&root.path().join(live));
        let held = File::open(root.path().join(live)).unwrap();
        assert_eq!(
            unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        fs::write(root.path().join(".unrelated.tmp"), "keep").unwrap();
        fs::write(root.path().join("document"), "old").unwrap();
        let mut candidate = Candidate::create(&dir).unwrap();
        assert!(candidate.hidden);
        assert!(!root.path().join(stale).exists());
        assert!(root.path().join(live).exists());
        assert!(root.path().join(".unrelated.tmp").exists());
        candidate.file().write_all(b"new").unwrap();
        candidate
            .publish(&dir, OsStr::new("document"), true)
            .unwrap();
        assert_eq!(fs::read(root.path().join("document")).unwrap(), b"new");
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
        let cache = other.path().join("cache");
        fs::create_dir(&cache).unwrap();
        let dir = open_dir(&worktree);
        assert!(Candidate::create_with_cache(&dir, None).is_err());
        let mut candidate = Candidate::create_with_cache(&dir, Some(cache.clone())).unwrap();
        assert!(!candidate.hidden);
        let actual = handle_path(&candidate.staging.try_clone().unwrap().into_std_file()).unwrap();
        assert!(actual.starts_with(&cache), "{}", actual.display());
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
        let pending = name(false).unwrap();
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
            let name = format!(".123-{:032x}.tmp", usize::from(fifo));
            let path = root.path().join(&name);
            if fifo {
                let name = CString::new(path.as_os_str().as_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            } else {
                std::os::unix::fs::symlink("missing", &path).unwrap();
            }
            cleanup(&dir, true).unwrap();
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
}
