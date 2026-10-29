//! A content file is created only after its parent is private. An early handle
//! to the empty directory cannot retain read access to a not-yet-created file.
use super::{access_control::AccessControl, file_identity::entry_matches};
use cap_std::fs::{Dir, DirBuilder, OpenOptions};
use std::{fs::File, io, path::Path};

pub(crate) const CONTENT: &str = "content";
pub(crate) struct PrivateDirectory {
    parent: Option<Dir>,
    name: String,
    #[cfg(target_os = "macos")]
    replacement_path: Option<std::path::PathBuf>,
    directory: Dir,
    identity: File,
}
impl PrivateDirectory {
    #[cfg(target_os = "macos")]
    pub(crate) fn for_destination(destination: &Dir) -> io::Result<Self> {
        use objc2::rc::autoreleasepool;
        use objc2_foundation::{
            NSFileManager, NSSearchPathDirectory, NSSearchPathDomainMask, NSURL,
        };
        use std::os::unix::ffi::{OsStrExt, OsStringExt};
        let destination_file = destination.try_clone()?.into_std_file();
        let destination_path =
            super::attachment::handle_path(&destination_file).map_err(io::Error::other)?;
        let c_path = std::ffi::CString::new(destination_path.as_os_str().as_bytes())
            .map_err(io::Error::other)?;
        let path = autoreleasepool(|_| {
            let url = unsafe {
                NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL(
                    std::ptr::NonNull::new(c_path.as_ptr().cast_mut()).expect("CString pointer"),
                    true,
                    None,
                )
            };
            let result = NSFileManager::defaultManager()
                .URLForDirectory_inDomain_appropriateForURL_create_error(
                    NSSearchPathDirectory::ItemReplacementDirectory,
                    NSSearchPathDomainMask::UserDomainMask,
                    Some(&url),
                    true,
                )
                .map_err(|error| {
                    io::Error::other(format!(
                        "Cannot create per-volume replacement directory: {error}"
                    ))
                })?;
            let bytes =
                unsafe { std::ffi::CStr::from_ptr(result.fileSystemRepresentation().as_ptr()) }
                    .to_bytes()
                    .to_vec();
            Ok::<_, io::Error>(std::path::PathBuf::from(std::ffi::OsString::from_vec(
                bytes,
            )))
        })?;
        let path = std::fs::canonicalize(path)
            .map_err(|e| io::Error::other(format!("canonicalize replacement dir: {e}")))?;
        let directory = staging_root(destination, &path)
            .map_err(|e| io::Error::other(format!("open replacement root {path:?}: {e}")))?;
        let name = path
            .file_name()
            .ok_or_else(|| io::Error::other("Replacement directory has no name"))?
            .to_string_lossy()
            .into_owned();
        let identity = directory.try_clone()?.into_std_file();
        use std::os::unix::fs::MetadataExt;
        if identity.metadata()?.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::other("Replacement directory owner changed"));
        }
        // macOS grants access to the created directory while denying open() on
        // its TemporaryItems parent. Keep the opened directory identity, and
        // recheck its returned pathname before cleanup; external races remain
        // best effort under the approved same-user threat model.
        let private = Self {
            parent: None,
            name,
            replacement_path: Some(path),
            directory,
            identity,
        };
        private
            .verify()
            .map_err(|e| io::Error::other(format!("verify replacement root: {e}")))?;
        AccessControl::privatize_directory(&private.identity)
            .map_err(|e| io::Error::other(format!("privatize replacement root: {e}")))?;
        if private
            .directory
            .entries()
            .map_err(|e| io::Error::other(format!("list replacement root: {e}")))?
            .next()
            .is_some()
        {
            return Err(io::Error::other("Replacement directory is not empty"));
        }
        private
            .verify()
            .map_err(|e| io::Error::other(format!("final replacement verify: {e}")))?;
        Ok(private)
    }
    #[cfg(target_os = "macos")]
    pub(crate) fn content_path(&self) -> io::Result<std::path::PathBuf> {
        self.verify()?;
        outside_worktrees(&self.identity)?;
        Ok(super::attachment::handle_path(&self.identity)
            .map_err(io::Error::other)?
            .join(CONTENT))
    }
    #[cfg(target_os = "macos")]
    pub(crate) fn cleanup_content(&self) {
        if self.verify().is_err() {
            return;
        }
        match self.directory.symlink_metadata(CONTENT) {
            Ok(meta) if meta.is_dir() => {
                let _ = self.directory.remove_dir_all(CONTENT);
            }
            Ok(_) => {
                let _ = self.directory.remove_file(CONTENT);
            }
            Err(_) => {}
        }
    }
    fn create(parent: &Dir) -> io::Result<Self> {
        let mut builder = DirBuilder::new();
        builder.recursive(false);
        #[cfg(unix)]
        {
            use cap_std::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        for _ in 0..8 {
            let mut random = [0; 16];
            getrandom::fill(&mut random).map_err(io::Error::other)?;
            let name = format!(".oarlock-stage-{:032x}", u128::from_le_bytes(random));
            match parent.create_dir_with(&name, &builder) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
            let directory = parent.open_dir(&name)?;
            let identity = directory.try_clone()?.into_std_file();
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if identity.metadata()?.uid() != unsafe { libc::geteuid() } {
                    // Never chmod or remove a substituted foreign directory.
                    return Err(io::Error::other("Staging directory owner changed"));
                }
            }
            let private = Self {
                parent: Some(parent.try_clone()?),
                name,
                #[cfg(target_os = "macos")]
                replacement_path: None,
                directory,
                identity,
            };
            private.verify()?;
            AccessControl::privatize_directory(&private.identity)?;
            // No inherited default/file ACL can expose a child while this
            // directory is private. Refuse any entries created before that.
            if private.directory.entries()?.next().is_some() {
                return Err(io::Error::other("Staging directory is not empty"));
            }
            private.verify()?;
            return Ok(private);
        }
        Err(io::Error::other(
            "Cannot allocate a private staging directory",
        ))
    }
    pub(crate) fn verify(&self) -> io::Result<()> {
        if let Some(parent) = &self.parent {
            if !entry_matches(parent, Path::new(&self.name), &self.identity)? {
                return Err(io::Error::other("Private staging directory changed"));
            }
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
            let path = self
                .replacement_path
                .as_ref()
                .ok_or_else(|| io::Error::other("Missing replacement path"))?;
            let current = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open(path)?;
            let current = current.metadata()?;
            let original = self.identity.metadata()?;
            if (current.dev(), current.ino()) != (original.dev(), original.ino()) {
                return Err(io::Error::other("Private staging directory changed"));
            }
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        Err(io::Error::other("Missing staging parent"))
    }
}
impl Drop for PrivateDirectory {
    fn drop(&mut self) {
        if self.verify().is_err() {
            return;
        }
        let result = if let Some(parent) = &self.parent {
            parent.remove_dir(&self.name)
        } else {
            #[cfg(target_os = "macos")]
            {
                self.replacement_path
                    .as_ref()
                    .map_or(Ok(()), std::fs::remove_dir)
            }
            #[cfg(not(target_os = "macos"))]
            {
                Ok(())
            }
        };
        if let Err(error) = result {
            log::warn!("Could not remove private staging directory: {error}");
        }
    }
}

pub(crate) struct PrivateCandidate {
    directory: PrivateDirectory,
    file: File,
}
impl PrivateCandidate {
    pub fn create(destination: &Dir) -> io::Result<Self> {
        #[cfg(target_os = "macos")]
        let directory = PrivateDirectory::for_destination(destination)?;
        #[cfg(not(target_os = "macos"))]
        let directory =
            PrivateDirectory::create(&staging_root(destination, &std::env::temp_dir())?)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = directory
            .directory
            .open_with(CONTENT, &options)
            .map_err(|e| io::Error::other(format!("create candidate: {e}")))?
            .into_std();
        let candidate = Self { directory, file };
        AccessControl::prepare_staging(&candidate.file)
            .map_err(|e| io::Error::other(format!("prepare candidate: {e}")))?;
        candidate
            .verify()
            .map_err(|e| io::Error::other(format!("verify candidate: {e}")))?;
        Ok(candidate)
    }
    pub fn file(&self) -> &File {
        &self.file
    }
    pub fn directory(&self) -> &Dir {
        &self.directory.directory
    }
    pub fn verify(&self) -> io::Result<()> {
        self.directory.verify()?;
        outside_worktrees(&self.directory.identity)?;
        if !entry_matches(self.directory(), Path::new(CONTENT), &self.file)? {
            return Err(io::Error::other("Private staging content changed"));
        }
        Ok(())
    }
    pub fn inheritance_from(&self, destination: &Dir) -> io::Result<AccessControl> {
        // Reproduce kernel inheritance using an EMPTY probe below the private
        // directory. Neither probe nor candidate ever enters the worktree.
        let probe = PrivateDirectory::create(self.directory())?;
        let source = destination.try_clone()?.into_std_file();
        let mut file = None;
        let result = (|| {
            AccessControl::prepare_inheritance(&source, &probe.identity)?;
            let mut options = OpenOptions::new();
            options.read(true).write(true).create_new(true);
            #[cfg(unix)]
            {
                use cap_std::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            file = Some(probe.directory.open_with(CONTENT, &options)?.into_std());
            AccessControl::capture(file.as_ref().expect("created probe"))
        })();
        // Parent rules may permit creation but deny deleting children. Clear
        // the private probe directory first; otherwise its empty child cannot
        // be removed. The outer private directory still prevents disclosure.
        let directory_cleanup = AccessControl::privatize_directory(&probe.identity);
        let cleanup = (|| {
            if let Some(file) = &file {
                AccessControl::privatize_empty_probe(file)?;
                if !entry_matches(&probe.directory, Path::new(CONTENT), file)? {
                    return Err(io::Error::other("Inheritance probe changed"));
                }
                probe.directory.remove_file(CONTENT)?;
            }
            Ok(())
        })();
        cleanup?;
        directory_cleanup?;
        result
    }
}
impl Drop for PrivateCandidate {
    fn drop(&mut self) {
        if entry_matches(self.directory(), Path::new(CONTENT), &self.file).unwrap_or(false) {
            if let Err(error) = self.directory().remove_file(CONTENT) {
                log::warn!("Could not remove private staging content: {error}");
            }
        }
    }
}

fn outside_worktrees(directory: &File) -> io::Result<()> {
    let path = super::attachment::handle_path(directory).map_err(io::Error::other)?;
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor.join(".git")) {
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Safe staging requires a temporary directory outside Git worktrees",
                ))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn staging_root(destination: &Dir, path: &Path) -> io::Result<Dir> {
    let root = Dir::open_ambient_dir(path, cap_std::ambient_authority())?;
    outside_worktrees(&root.try_clone()?.into_std_file())?;
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        if root.dir_metadata()?.dev() != destination.dir_metadata()?.dev() {
            return Err(io::Error::new(io::ErrorKind::Unsupported, "Safe staging needs a temporary directory on the destination filesystem; no worktree fallback is allowed"));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = destination;
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Same-filesystem private staging is unsupported on this platform",
        ));
    }
    #[cfg(unix)]
    Ok(root)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::modules::fs::access_control::tests::{acl_text, add_acl};
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn temporary_roots_inside_worktrees_or_on_another_filesystem_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let destination = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        std::fs::create_dir(root.path().join("tmp")).unwrap();
        let error = staging_root(&destination, &root.path().join("tmp")).unwrap_err();
        assert!(error.to_string().contains("outside Git worktrees"));
        assert_eq!(
            std::fs::read_dir(root.path().join("tmp")).unwrap().count(),
            0
        );
        let error = staging_root(&destination, Path::new("/dev")).unwrap_err();
        assert!(error.to_string().contains("destination filesystem"));
    }

    #[test]
    #[ignore = "requires OARLOCK_TEST_VOLUME pointing to a separate writable mounted filesystem"]
    fn cross_volume_staging_stays_private_and_saves_conditionally() {
        use super::super::{destination::Destination, document_save};
        use std::os::unix::fs::MetadataExt;
        let volume = std::env::var_os("OARLOCK_TEST_VOLUME").expect("set OARLOCK_TEST_VOLUME");
        let root = tempfile::tempdir_in(volume).unwrap();
        assert_ne!(
            root.path().metadata().unwrap().dev(),
            std::env::temp_dir().metadata().unwrap().dev()
        );
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
        std::fs::write(root.path().join(".gitignore"), ".env\n").unwrap();
        let target = root.path().join(".env");
        std::fs::write(&target, b"original").unwrap();
        let destination = Destination::pin(&target, false, &|_| Ok(())).unwrap();
        let staged = destination.stage(b"private draft").unwrap();
        assert_eq!(
            staged.file().metadata().unwrap().dev(),
            root.path().metadata().unwrap().dev()
        );
        let status = git(&["status", "--porcelain", "--untracked-files=all"]);
        assert!(
            !status.contains("NSIRD") && !status.contains("oarlock-stage"),
            "{status}"
        );
        git(&["add", "--all"]);
        assert_eq!(
            git(&["diff", "--cached", "--name-only"]).trim(),
            ".gitignore"
        );
        drop(staged);
        let original = std::fs::File::open(&target).unwrap();
        let version = document_save::version(&original, b"original").unwrap();
        document_save::write_checked(&target, b"updated", Some(&version), |_| Ok(())).unwrap();
        assert_eq!(std::fs::read(target).unwrap(), b"updated");
    }

    #[test]
    fn inherited_directory_grants_are_removed_before_a_content_file_exists() {
        let root = tempfile::tempdir().unwrap();
        add_acl(
            root.path(),
            "group:everyone allow read,search,file_inherit,directory_inherit",
        );
        let parent = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let private = PrivateDirectory::create(&parent).unwrap();
        assert_eq!(private.directory.entries().unwrap().count(), 0);
        assert_eq!(
            private.identity.metadata().unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(acl_text(&root.path().join(&private.name)), "");
        drop(private);
        assert_eq!(parent.entries().unwrap().count(), 0);
        let candidate = PrivateCandidate::create(&parent).unwrap();
        assert_eq!(candidate.directory().entries().unwrap().count(), 1);
        drop(candidate);
        assert_eq!(parent.entries().unwrap().count(), 0);
    }
}
