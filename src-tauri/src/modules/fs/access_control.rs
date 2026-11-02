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
    /// Only folders carry one (captured by `capture_directory`).
    #[cfg(target_os = "linux")]
    default_acl: Option<Vec<u8>>,
}

/// What `apply_for_copy` could keep, for the later `finalize_for_copy`.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy)]
pub(crate) struct CopyApplied {
    pub group_kept: bool,
    pub owner_kept: bool,
    pub final_mode: u32,
}
#[cfg(target_os = "linux")]
pub(crate) fn real_chown(file: &File, owner: u32, group: u32) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::fchown(file.as_raw_fd(), owner, group) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

impl AccessControl {
    /// The permission bits captured from the source.
    #[cfg(target_os = "linux")]
    pub(crate) fn mode(&self) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        self.permissions.mode() & 0o7777
    }
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    pub(crate) fn privatize_empty_probe(file: &File) -> io::Result<()> {
        if !file.metadata()?.is_file() || file.metadata()?.len() != 0 {
            return Err(io::Error::other("Inheritance probe is not empty"));
        }
        platform::privatize(file)
    }
    #[cfg_attr(target_os = "linux", allow(dead_code))]
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
        Self::capture_kind(file, false)
    }
    /// A folder's access rules, from a readable directory descriptor.
    #[cfg(target_os = "linux")]
    pub(crate) fn capture_directory(file: &File) -> io::Result<Self> {
        Self::capture_kind(file, true)
    }
    fn capture_kind(file: &File, directory: bool) -> io::Result<Self> {
        let before = super::document_save::change_stamp(file)?;
        let meta = file.metadata()?;
        if !(meta.is_file() || (directory && meta.is_dir())) {
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
        #[cfg(target_os = "linux")]
        let default_acl = if directory {
            platform::read_default(file)?
        } else {
            None
        };
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
            #[cfg(target_os = "linux")]
            default_acl,
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

    /// Puts the captured rules on a fresh copy. Ownership is best effort, as
    /// `cp` does for a user who cannot give files away; a group that cannot be
    /// kept must not widen access, so its bits are cleared (no ACL) or the copy
    /// is refused (an ACL mask would grant them to the wrong group). With
    /// `defer_mode`, the owner keeps rwx so the folder can still be moved.
    #[cfg(target_os = "linux")]
    pub(crate) fn apply_for_copy(
        &self,
        staged: &File,
        chown: &dyn Fn(&File, u32, u32) -> io::Result<()>,
        defer_mode: bool,
    ) -> io::Result<CopyApplied> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let directory = staged.metadata()?.is_dir();
        let current = staged.metadata()?;
        if (current.uid(), current.gid()) != (self.owner, self.group)
            && chown(staged, self.owner, self.group).is_err()
        {
            let _ = chown(staged, u32::MAX, self.group);
        }
        let now = staged.metadata()?;
        let (owner_kept, group_kept) = (now.uid() == self.owner, now.gid() == self.group);
        let mut mode = self.permissions.mode() & 0o7777;
        if !group_kept {
            if mode & 0o070 != 0 {
                if self.acl.has_rules() {
                    return Err(io::Error::other(
                        "The group of this item cannot be kept and its access rules would grant its permissions to another group; not copied",
                    ));
                }
                mode &= !0o070;
            }
            mode &= !0o2000;
        }
        let first = if defer_mode { mode | 0o700 } else { mode };
        self.extended.apply_for_copy(staged)?;
        platform::apply(&self.acl, staged).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("Cannot preserve access rules; not copied: {error}"),
            )
        })?;
        if directory {
            platform::apply_default(&self.default_acl, staged).map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!("Cannot preserve the folder's default access rules; not copied: {error}"),
                )
            })?;
        }
        staged.set_permissions(std::fs::Permissions::from_mode(first))?;
        let applied = CopyApplied {
            group_kept,
            owner_kept,
            final_mode: mode,
        };
        self.verify_copy(staged, &applied, first, !defer_mode)?;
        Ok(applied)
    }
    /// Sets the final mode of a folder that had to stay writable until it was
    /// published, then checks everything again.
    #[cfg(target_os = "linux")]
    pub(crate) fn finalize_for_copy(&self, staged: &File, applied: &CopyApplied) -> io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        platform::apply(&self.acl, staged)?;
        staged.set_permissions(std::fs::Permissions::from_mode(applied.final_mode))?;
        self.verify_copy(staged, applied, applied.final_mode, true)
    }
    #[cfg(target_os = "linux")]
    fn verify_copy(
        &self,
        file: &File,
        applied: &CopyApplied,
        mode: u32,
        acl_exact: bool,
    ) -> io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let now = Self::capture_kind(file, file.metadata()?.is_dir())?;
        let same = now.extended == self.extended
            && now.default_acl == self.default_acl
            && now.permissions.mode() & 0o7777 == mode
            && (!acl_exact || now.acl == self.acl)
            && (!applied.group_kept || now.group == self.group)
            && (!applied.owner_kept || now.owner == self.owner);
        if same {
            Ok(())
        } else {
            Err(io::Error::other(
                "Access-control preservation could not be verified; not copied",
            ))
        }
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

#[cfg(all(test, target_os = "linux"))]
mod copy_tests {
    use super::*;
    use crate::modules::fs::linux_staging::tests::test_dir;
    use std::os::{fd::AsRawFd, unix::fs::PermissionsExt};

    fn refused(_: &File, _: u32, _: u32) -> io::Result<()> {
        Err(io::Error::from_raw_os_error(libc::EPERM))
    }
    fn another_groups_file(mode: u32, acl: bool) -> (tempfile::TempDir, AccessControl, File) {
        let dir = test_dir();
        let source = tempfile::tempfile_in(dir.path()).unwrap();
        source
            .set_permissions(std::fs::Permissions::from_mode(mode))
            .unwrap();
        if acl {
            let mut bytes = 2u32.to_le_bytes().to_vec();
            for (tag, permissions, id) in [
                (1u16, 6u16, u32::MAX),
                (2, 4, 65534),
                (4, 0, u32::MAX),
                (16, 4, u32::MAX),
                (32, 0, u32::MAX),
            ] {
                bytes.extend_from_slice(&tag.to_le_bytes());
                bytes.extend_from_slice(&permissions.to_le_bytes());
                bytes.extend_from_slice(&id.to_le_bytes());
            }
            let set = unsafe {
                libc::fsetxattr(
                    source.as_raw_fd(),
                    c"system.posix_acl_access".as_ptr(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    0,
                )
            };
            assert_eq!(set, 0, "POSIX ACLs unsupported here");
        }
        let mut captured = AccessControl::capture(&source).unwrap();
        // The source belongs to a group the copier cannot give files to.
        captured.group = captured.group.wrapping_add(1);
        let target = tempfile::tempfile_in(dir.path()).unwrap();
        (dir, captured, target)
    }

    #[test]
    fn a_group_that_cannot_be_kept_loses_its_bits_when_there_is_no_acl() {
        let (_dir, captured, target) = another_groups_file(0o640, false);
        let applied = captured.apply_for_copy(&target, &refused, false).unwrap();
        assert!(!applied.group_kept);
        assert_eq!(
            target.metadata().unwrap().permissions().mode() & 0o7777,
            0o600
        );
    }
    #[test]
    fn a_group_that_cannot_be_kept_refuses_an_acl_that_would_widen_access() {
        let (_dir, captured, target) = another_groups_file(0o640, true);
        let error = captured
            .apply_for_copy(&target, &refused, false)
            .unwrap_err();
        assert!(error.to_string().contains("another group"), "{error}");
    }
    #[test]
    fn a_kept_group_keeps_its_bits_and_a_deferred_mode_stays_writable() {
        let dir = test_dir();
        let source = tempfile::tempfile_in(dir.path()).unwrap();
        source
            .set_permissions(std::fs::Permissions::from_mode(0o440))
            .unwrap();
        let captured = AccessControl::capture(&source).unwrap();
        let target = tempfile::tempfile_in(dir.path()).unwrap();
        let applied = captured.apply_for_copy(&target, &real_chown, true).unwrap();
        assert!(applied.group_kept);
        assert_eq!(
            target.metadata().unwrap().permissions().mode() & 0o7777,
            0o740
        );
        captured.finalize_for_copy(&target, &applied).unwrap();
        assert_eq!(
            target.metadata().unwrap().permissions().mode() & 0o7777,
            0o440
        );
    }
}
