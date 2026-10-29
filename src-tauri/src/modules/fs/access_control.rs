//! Handle-bound access rules and supported extended metadata for replacements.
//! Never turn a failed read into absence, or publish before read-back verification.
use std::{fs::File, io};
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod extended;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod extended {
    use super::*;
    #[derive(Debug, PartialEq, Eq)]
    pub struct Extended;
    impl Extended {
        pub fn capture(_: &File) -> io::Result<Self> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Extended metadata preservation is unsupported",
            ))
        }
        pub fn apply(&self, _: &File) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Extended metadata preservation is unsupported",
            ))
        }
    }
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as platform;

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    use super::*;
    #[derive(Debug, PartialEq, Eq)]
    pub struct Acl;
    pub fn read(_: &File) -> io::Result<Acl> {
        Err(io::Error::new(io::ErrorKind::Unsupported,
            "Safe ACL preservation is not supported on this platform; the existing file was not replaced"))
    }
    pub fn apply(_: &Acl, _: &File) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "ACL preservation is unsupported",
        ))
    }
    pub fn privatize(_: &File) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Private ACL staging is unsupported",
        ))
    }
    pub fn inherit_directory(_: &File, _: &File) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "ACL inheritance is unsupported",
        ))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct AccessControl {
    acl: platform::Acl,
    extended: extended::Extended,
    #[cfg(unix)]
    owner: u32,
    #[cfg(unix)]
    group: u32,
    permissions: std::fs::Permissions,
}

impl AccessControl {
    pub(crate) fn privatize_empty_probe(file: &File) -> io::Result<()> {
        if !file.metadata()?.is_file() || file.metadata()?.len() != 0 {
            return Err(io::Error::other("Inheritance probe is not empty"));
        }
        platform::privatize(file)
    }
    pub(crate) fn prepare_inheritance(source: &File, private: &File) -> io::Result<()> {
        let before = super::document_save::change_stamp(source)?;
        let meta = source.metadata()?;
        if !meta.is_dir() || !private.metadata()?.is_dir() {
            return Err(io::Error::other("ACL inheritance requires directories"));
        }
        #[cfg(unix)]
        {
            use std::os::{
                fd::AsRawFd,
                unix::fs::{MetadataExt, PermissionsExt},
            };
            // BSD inherits the parent's group; Linux does so for setgid dirs.
            let group = if cfg!(target_os = "macos") || meta.mode() & 0o2000 != 0 {
                meta.gid()
            } else {
                // This directory was created below a private non-setgid
                // parent, so the kernel already selected the caller's fs gid.
                private.metadata()?.gid()
            };
            if private.metadata()?.gid() != group
                && unsafe { libc::fchown(private.as_raw_fd(), u32::MAX, group) } != 0
            {
                return Err(io::Error::last_os_error());
            }
            private.set_permissions(std::fs::Permissions::from_mode(
                0o700 | (meta.mode() & 0o2000),
            ))?;
        }
        platform::inherit_directory(source, private)?;
        if before != super::document_save::change_stamp(source)? {
            return Err(io::Error::other(
                "Destination inheritance rules changed; retry the save",
            ));
        }
        Ok(())
    }
    pub(crate) fn privatize_directory(file: &File) -> io::Result<()> {
        if !file.metadata()?.is_dir() {
            return Err(io::Error::other("Staging directory changed"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if file.metadata()?.uid() != unsafe { libc::geteuid() } {
                return Err(io::Error::other("Staging directory has a different owner"));
            }
            platform::privatize(file)?;
            file.set_permissions(std::fs::Permissions::from_mode(0o700))?;
            if file.metadata()?.permissions().mode() & 0o777 != 0o700 {
                return Err(io::Error::other("Cannot make staging directory private"));
            }
        }
        #[cfg(not(unix))]
        platform::privatize(file)?;
        Ok(())
    }
    /// Newly created files may inherit ACL grants despite mode 0600. Capture
    /// their final rules, then remove those grants BEFORE writing any content.
    pub fn prepare_staging(file: &File) -> io::Result<Self> {
        let inherited = Self::capture(file)?;
        platform::privatize(file)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            if file.metadata()?.permissions().mode() & 0o777 != 0o600 {
                return Err(io::Error::other("Cannot make staging permissions private"));
            }
        }
        Ok(inherited)
    }
    pub fn capture(file: &File) -> io::Result<Self> {
        let before = super::document_save::change_stamp(file)?;
        let meta = file.metadata()?;
        if !meta.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Access-control replacement requires a regular file",
            ));
        }
        let acl = platform::read(file).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("Cannot read access rules safely: {error}"),
            )
        })?;
        let extended = extended::Extended::capture(file)?;
        if before != super::document_save::change_stamp(file)? {
            return Err(io::Error::other(
                "Access rules changed during capture; retry the save",
            ));
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            acl,
            extended,
            #[cfg(unix)]
            owner: meta.uid(),
            #[cfg(unix)]
            group: meta.gid(),
            permissions: meta.permissions(),
        })
    }

    pub fn apply(&self, staged: &File) -> io::Result<()> {
        #[cfg(unix)]
        {
            use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
            let meta = staged.metadata()?;
            if (meta.uid(), meta.gid()) != (self.owner, self.group)
                && unsafe { libc::fchown(staged.as_raw_fd(), self.owner, self.group) } != 0
            {
                return Err(io::Error::other(format!(
                    "Cannot preserve the file's access-control owner/group: {}",
                    io::Error::last_os_error()
                )));
            }
        }
        self.extended.apply(staged)?;
        platform::apply(&self.acl, staged).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("Cannot preserve access rules; file not replaced: {error}"),
            )
        })?;
        // Install restrictions before widening the private staging file's mode.
        staged.set_permissions(self.permissions.clone())?;
        self.verify(staged)?;
        staged.sync_all()
    }

    pub fn verify(&self, file: &File) -> io::Result<()> {
        if Self::capture(file)? != *self {
            return Err(io::Error::other(
                "Access-control preservation could not be verified; file not replaced",
            ));
        }
        Ok(())
    }
}

#[cfg(all(test, target_os = "macos"))]
pub(crate) mod tests {
    use super::*;
    use std::{path::Path, process::Command};

    pub fn add_acl(path: &Path, rule: &str) {
        let status = Command::new("/bin/chmod")
            .args(["+a", rule])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }
    pub fn acl_text(path: &Path) -> String {
        let output = Command::new("/bin/ls")
            .arg("-lde")
            .arg(path)
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn copies_ordered_acl_entries_and_removes_inherited_staging_rules() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let target = dir.path().join("target");
        std::fs::write(&source, b"base").unwrap();
        std::fs::write(&target, b"candidate").unwrap();
        add_acl(&source, "group:everyone deny execute");
        add_acl(&source, "group:everyone allow readattr,readextattr");
        let expected = acl_text(&source);
        assert!(expected.contains("deny execute"));
        let captured = AccessControl::capture(&File::open(&source).unwrap()).unwrap();
        let staged = File::options()
            .read(true)
            .write(true)
            .open(&target)
            .unwrap();
        captured.apply(&staged).unwrap();
        assert_eq!(acl_text(&target), expected);

        let plain = dir.path().join("plain");
        std::fs::write(&plain, b"plain").unwrap();
        let plain = AccessControl::capture(&File::open(&plain).unwrap()).unwrap();
        plain.apply(&staged).unwrap();
        assert_eq!(acl_text(&target), "");

        add_acl(dir.path(), "group:everyone allow readattr,file_inherit");
        let inherited = dir.path().join("inherited");
        let staged = File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&inherited)
            .unwrap();
        assert!(acl_text(&inherited).contains("inherited"));
        plain.apply(&staged).unwrap();
        assert_eq!(acl_text(&inherited), "");
    }

    #[test]
    fn read_and_apply_errors_never_mean_an_empty_acl() {
        use std::os::{fd::OwnedFd, unix::net::UnixStream};
        let (socket, _peer) = UnixStream::pair().unwrap();
        let invalid = File::from(OwnedFd::from(socket));
        assert!(AccessControl::capture(&invalid).is_err());
        let source = tempfile::tempfile().unwrap();
        let access = AccessControl::capture(&source).unwrap();
        assert!(access.apply(&invalid).is_err());
    }
}
