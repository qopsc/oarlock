//! Operation-scoped directory capabilities. After acquisition, no mutation or
//! temporary-file cleanup resolves an absolute destination path again.
use super::private_staging::{PrivateCandidate, CONTENT};
use cap_std::fs::{Dir, OpenOptions};
use std::{
    ffi::OsString,
    fs, io,
    io::Write,
    path::{Path, PathBuf},
};

pub(super) struct Destination {
    dir: Dir,
    name: OsString,
    opened: PathBuf,
}

fn directory_path(dir: &Dir) -> io::Result<PathBuf> {
    super::attachment::handle_path(&dir.try_clone()?.into_std_file()).map_err(io::Error::other)
}

impl Destination {
    pub fn pin(
        target: &Path,
        create_parents: bool,
        validate: &impl Fn(&Path) -> Result<(), String>,
    ) -> io::Result<Self> {
        let name = target
            .file_name()
            .ok_or_else(|| io::Error::other("File has no name"))?;
        let mut parent = target
            .parent()
            .ok_or_else(|| io::Error::other("File has no parent"))?;
        let mut missing = Vec::new();
        let mut dir = loop {
            match Dir::open_ambient_dir(parent, cap_std::ambient_authority()) {
                Ok(dir) => break dir,
                Err(error) if create_parents && error.kind() == io::ErrorKind::NotFound => {
                    missing.push(
                        parent
                            .file_name()
                            .ok_or_else(|| io::Error::other("No existing destination parent"))?
                            .to_owned(),
                    );
                    parent = parent
                        .parent()
                        .ok_or_else(|| io::Error::other("No existing destination parent"))?;
                }
                Err(error) => return Err(error),
            }
        };
        // Validate the actual handle before creating even an empty directory or
        // staging file. An ambient open may have followed a replaced ancestor.
        loop {
            let anchor = directory_path(&dir)?;
            let mut actual = anchor.clone();
            for component in missing.iter().rev() {
                actual.push(component);
            }
            actual.push(name);
            validate(&actual).map_err(io::Error::other)?;
            if directory_path(&dir)? != anchor {
                return Err(io::Error::other(
                    "Destination directory moved during acquisition",
                ));
            }
            let Some(component) = missing.pop() else {
                break;
            };
            match dir.create_dir(&component) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
            dir = dir.open_dir(&component)?;
        }
        let opened = directory_path(&dir)?.join(name);
        let destination = Self {
            dir,
            name: name.to_owned(),
            opened,
        };
        Ok(destination)
    }

    pub fn validate(&self, validate: &impl Fn(&Path) -> Result<(), String>) -> io::Result<()> {
        let actual = directory_path(&self.dir)?.join(&self.name);
        if actual != self.opened {
            return Err(io::Error::other(
                "Destination directory moved during the operation",
            ));
        }
        validate(&actual).map_err(io::Error::other)
    }

    pub fn open_current(&self) -> io::Result<fs::File> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let file = self.dir.open_with(&self.name, &options)?.into_std();
        // cap-std confines symlink resolution to the directory, but may follow
        // a link to another entry in it. Reject that identity before any read.
        let opened = super::attachment::handle_path(&file).map_err(io::Error::other)?;
        if opened != self.opened {
            return Err(io::Error::other(
                "Destination entry changed during operation",
            ));
        }
        if !file.metadata()?.is_file() {
            return Err(io::Error::other("Destination is not a regular file"));
        }
        Ok(file)
    }

    pub fn create_file(&self) -> io::Result<()> {
        self.dir
            .open_with(&self.name, OpenOptions::new().write(true).create_new(true))
            .map(|_| ())
    }

    pub fn create_dir(&self) -> io::Result<()> {
        self.dir.create_dir(&self.name)
    }

    pub fn stage(&self, content: &[u8]) -> io::Result<Staged<'_>> {
        let candidate = PrivateCandidate::create(&self.dir)?;
        candidate.file().write_all(content)?;
        candidate.file().sync_all()?;
        Ok(Staged {
            destination: self,
            candidate,
        })
    }
}

pub(super) struct Staged<'a> {
    destination: &'a Destination,
    candidate: PrivateCandidate,
}
impl Staged<'_> {
    pub fn file(&self) -> &fs::File {
        self.candidate.file()
    }
    pub fn persist(self, replace: bool) -> io::Result<fs::File> {
        let dir = &self.destination.dir;
        // Allocate the returned handle before publication, never after commit.
        let file = self.file().try_clone()?;
        if !replace {
            self.candidate.inheritance_from(dir)?.apply(self.file())?;
        }
        self.candidate.verify()?;
        // A cooperating external writer can still change the final destination
        // after its last version check; this is not a filesystem-wide CAS.
        if replace {
            self.candidate
                .directory()
                .rename(CONTENT, dir, &self.destination.name)?;
        } else {
            self.candidate
                .directory()
                .hard_link(CONTENT, dir, &self.destination.name)?;
        }
        Ok(file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn creating_a_file_in_a_delete_child_protected_directory_cleans_its_probe() {
        use super::super::access_control::tests::add_acl;
        let root = tempfile::tempdir().unwrap();
        add_acl(root.path(), "group:everyone deny delete_child");
        let target = root.path().join("document");
        fs::write(root.path().join("control"), b"control").unwrap();
        let dest = Destination::pin(&target, false, &|_| Ok(())).unwrap();
        let staged = dest.stage(b"draft").unwrap();
        let staging_path = super::super::attachment::handle_path(staged.file()).unwrap();
        let staging_dir = staging_path.parent().unwrap().to_owned();
        let result = staged.persist(false);
        assert!(std::process::Command::new("/bin/chmod")
            .arg("-N")
            .arg(root.path())
            .status()
            .unwrap()
            .success());
        assert!(
            result.is_ok(),
            "ordinary new-file creation failed: {result:?}"
        );
        assert_eq!(fs::read(&target).unwrap(), b"draft");
        assert!(
            !staging_dir.exists(),
            "empty inheritance probe was stranded"
        );
    }

    #[test]
    fn terminal_git_cannot_stage_an_ignored_files_in_progress_draft() {
        let root = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .current_dir(root.path())
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap()
        };
        git(&["init", "-q"]);
        fs::write(root.path().join(".gitignore"), ".env\n").unwrap();
        let target = root.path().join(".env");
        fs::write(&target, b"old ignored contents").unwrap();
        let dest = Destination::pin(&target, false, &|_| Ok(())).unwrap();
        let staged = dest.stage(b"SYNTHETIC_UNSUBMITTED_SECRET=private").unwrap();
        let status = git(&["status", "--porcelain", "--untracked-files=all"]);
        assert!(!status.contains("oarlock"), "{status}");
        git(&["add", "--all"]);
        assert_eq!(
            git(&["diff", "--cached", "--name-only"]).trim(),
            ".gitignore"
        );
        staged.persist(true).unwrap();
        assert_eq!(
            fs::read(&target).unwrap(),
            b"SYNTHETIC_UNSUBMITTED_SECRET=private"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn outside_staging_preserves_new_file_acl_inheritance() {
        use super::super::access_control::tests::{acl_text, add_acl};
        use std::os::unix::fs::OpenOptionsExt;
        let root = tempfile::tempdir().unwrap();
        add_acl(root.path(), "group:everyone allow read,file_inherit");
        add_acl(
            root.path(),
            "group:everyone deny execute,file_inherit,only_inherit",
        );
        // A non-inheriting deny-delete on the directory must not prevent new files.
        add_acl(root.path(), "group:everyone deny delete");
        let control = root.path().join("control");
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&control)
            .unwrap();
        let target = root.path().join("document");
        let dest = Destination::pin(&target, false, &|_| Ok(())).unwrap();
        let result = dest.stage(b"new text").unwrap().persist(false);
        assert!(std::process::Command::new("/bin/chmod")
            .arg("-N")
            .arg(root.path())
            .status()
            .unwrap()
            .success());
        result.unwrap();
        assert_eq!(acl_text(&target), acl_text(&control));
        assert_eq!(fs::read(&target).unwrap(), b"new text");
    }

    #[test]
    fn staged_contents_never_enter_the_destination_directory() {
        for replace in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let target = root.path().join("document");
            if replace {
                fs::write(&target, b"old").unwrap();
            }
            let dest = Destination::pin(&target, false, &|_| Ok(())).unwrap();
            let staged = dest.stage(b"PRIVATE_DRAFT").unwrap();
            assert_eq!(
                fs::read_dir(root.path()).unwrap().count(),
                usize::from(replace)
            );
            staged.persist(replace).unwrap();
            assert_eq!(fs::read(&target).unwrap(), b"PRIVATE_DRAFT");
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        }
    }

    #[cfg(unix)]
    #[test]
    fn substituted_symlinks_and_fifos_are_not_followed_or_removed() {
        use std::os::unix::{ffi::OsStrExt, fs::symlink};
        for fifo in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let target = root.path().join("document");
            fs::write(&target, b"original").unwrap();
            let dest = Destination::pin(&target, false, &|_| Ok(())).unwrap();
            let staged = dest.stage(b"draft").unwrap();
            let stage_path = super::super::attachment::handle_path(staged.file()).unwrap();
            let held = root.path().join("held");
            fs::rename(&stage_path, &held).unwrap();
            if fifo {
                let name = std::ffi::CString::new(stage_path.as_os_str().as_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            } else {
                symlink(&held, &stage_path).unwrap();
            }
            assert!(staged.persist(true).is_err());
            assert!(fs::symlink_metadata(&stage_path).is_ok());
            assert_eq!(fs::read(&target).unwrap(), b"original");
            fs::remove_file(&stage_path).unwrap();
            fs::remove_dir(stage_path.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn substituted_staging_entry_is_never_published_or_deleted() {
        for publish in [true, false] {
            for replace in [false, true] {
                let root = tempfile::tempdir().unwrap();
                let target = root.path().join("document");
                if replace {
                    fs::write(&target, b"original").unwrap();
                }
                let dest = Destination::pin(&target, false, &|_| Ok(())).unwrap();
                let staged = dest.stage(b"draft").unwrap();
                let stage_path = super::super::attachment::handle_path(staged.file()).unwrap();
                fs::rename(&stage_path, root.path().join("held-candidate")).unwrap();
                fs::write(&stage_path, b"unrelated content").unwrap();
                if publish {
                    assert!(
                        staged.persist(replace).is_err(),
                        "published a substituted entry"
                    );
                } else {
                    drop(staged);
                }
                assert_eq!(
                    fs::read(&stage_path).unwrap(),
                    b"unrelated content",
                    "cleanup deleted an unowned entry"
                );
                if replace {
                    assert_eq!(fs::read(&target).unwrap(), b"original");
                } else {
                    assert!(!target.exists());
                }
                fs::remove_file(&stage_path).unwrap();
                fs::remove_dir(stage_path.parent().unwrap()).unwrap();
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn inherited_acl_never_exposes_private_staging_content_or_blocks_cleanup() {
        use super::super::access_control::tests::{acl_text, add_acl};
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        add_acl(root.path(), "group:everyone allow read,file_inherit");
        add_acl(
            root.path(),
            "group:everyone deny delete,file_inherit,only_inherit",
        );
        let dest = Destination::pin(&root.path().join("doc"), false, &|_| Ok(())).unwrap();
        let staged = dest.stage(b"private draft").unwrap();
        let path = super::super::attachment::handle_path(staged.file()).unwrap();
        assert_eq!(acl_text(&path), "");
        assert_eq!(
            staged.file().metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
        // The inherited deny-delete rule cannot safely be restored for creation.
        assert!(staged.persist(false).is_err());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        assert!(std::process::Command::new("/bin/chmod")
            .arg("-N")
            .arg(root.path())
            .status()
            .unwrap()
            .success());
    }

    #[cfg(unix)]
    #[test]
    fn moved_directory_never_redirects_creation_publication_or_cleanup() {
        use std::os::unix::fs::symlink;
        for replace in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let parent = root.path().join("parent");
            let moved = root.path().join("moved");
            let outside = root.path().join("outside");
            fs::create_dir(&parent).unwrap();
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("document"), b"outside").unwrap();
            if replace {
                fs::write(parent.join("document"), b"base").unwrap();
            }
            let dest = Destination::pin(&parent.join("document"), false, &|_| Ok(())).unwrap();
            let staged = dest.stage(b"draft").unwrap();
            let stage_path = super::super::attachment::handle_path(staged.file()).unwrap();
            let temporary_name = stage_path.file_name().unwrap();
            fs::rename(&parent, &moved).unwrap();
            symlink(&outside, &parent).unwrap();
            // A replacement directory even gets a file of the staging name;
            // cleanup must not remove it.
            fs::write(outside.join(temporary_name), b"sentinel").unwrap();
            assert!(dest.validate(&|_| Ok(())).is_err());
            // Exercise the last-check-to-operation race directly: all native
            // operations still resolve relative to the acquired directory.
            staged.persist(replace).unwrap();
            assert_eq!(fs::read(moved.join("document")).unwrap(), b"draft");
            assert_eq!(fs::read(outside.join("document")).unwrap(), b"outside");
            assert_eq!(fs::read(outside.join(temporary_name)).unwrap(), b"sentinel");
            assert!(!stage_path.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn failed_save_cleans_up_inside_the_original_directory() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("parent");
        let moved = root.path().join("moved");
        fs::create_dir(&parent).unwrap();
        let dest = Destination::pin(&parent.join("doc"), false, &|_| Ok(())).unwrap();
        let staged = dest.stage(b"draft").unwrap();
        fs::rename(&parent, &moved).unwrap();
        fs::create_dir(&parent).unwrap();
        fs::write(parent.join(CONTENT), b"sentinel").unwrap();
        drop(staged);
        assert_eq!(fs::read_dir(&moved).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn comparison_refuses_symlinks_and_fifos_without_reading_their_contents() {
        use std::os::unix::{ffi::OsStrExt, fs::symlink};
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("other"), b"private").unwrap();
        symlink("other", root.path().join("link")).unwrap();
        let link = Destination::pin(&root.path().join("link"), false, &|_| Ok(())).unwrap();
        assert!(link.open_current().is_err());
        let fifo = root.path().join("pipe");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let fifo = Destination::pin(&fifo, false, &|_| Ok(())).unwrap();
        assert!(fifo.open_current().is_err());
    }

    #[test]
    fn failed_validation_writes_no_temporary_content() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            Destination::pin(&root.path().join("file"), false, &|_| Err("denied".into())).is_err()
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
