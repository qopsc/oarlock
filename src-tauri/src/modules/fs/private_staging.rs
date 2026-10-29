//! A content file is created only after its parent is private. An early handle
//! to the empty directory cannot retain read access to a not-yet-created file.
use super::{access_control::AccessControl, file_identity::entry_matches};
use cap_std::fs::{Dir, DirBuilder, OpenOptions};
use std::{fs::File, io, path::Path};

pub(crate) const CONTENT: &str = "content";
struct PrivateDirectory {
    parent: Dir,
    name: String,
    directory: Dir,
    identity: File,
}
impl PrivateDirectory {
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
                parent: parent.try_clone()?,
                name,
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
    fn verify(&self) -> io::Result<()> {
        if !entry_matches(&self.parent, Path::new(&self.name), &self.identity)? {
            return Err(io::Error::other("Private staging directory changed"));
        }
        Ok(())
    }
}
impl Drop for PrivateDirectory {
    fn drop(&mut self) {
        if self.verify().is_ok() {
            if let Err(error) = self.parent.remove_dir(&self.name) {
                log::warn!("Could not remove private staging directory: {error}");
            }
        }
    }
}

pub(crate) struct PrivateCandidate {
    directory: PrivateDirectory,
    file: File,
}
impl PrivateCandidate {
    pub fn create(destination: &Dir) -> io::Result<Self> {
        let parent = staging_root(destination, &std::env::temp_dir())?;
        let directory = PrivateDirectory::create(&parent)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = directory.directory.open_with(CONTENT, &options)?.into_std();
        let candidate = Self { directory, file };
        AccessControl::prepare_staging(&candidate.file)?;
        candidate.verify()?;
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
