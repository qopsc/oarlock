use std::{fs::File, io, os::fd::AsRawFd};

#[derive(Debug, PartialEq, Eq)]
pub struct Acl(Option<Vec<u8>>);
const NAME: &std::ffi::CStr = c"system.posix_acl_access";

pub fn read(file: &File) -> io::Result<Acl> {
    // A non-POSIX ACL can grant access to a private staging directory even
    // after chmod; do not treat an unsupported POSIX ACL query as its absence.
    let other_acl = unsafe {
        libc::fgetxattr(file.as_raw_fd(), c"system.nfs4_acl".as_ptr(), std::ptr::null_mut(), 0)
    };
    if other_acl >= 0 {
        return Err(io::Error::new(io::ErrorKind::Unsupported,
            "NFSv4 ACL preservation is unsupported; file not replaced"));
    }
    let error = io::Error::last_os_error();
    if !matches!(error.raw_os_error(), Some(libc::ENODATA | libc::EOPNOTSUPP)) {
        return Err(error);
    }
    let mut bytes = vec![0; 65536];
    let count = unsafe {
        libc::fgetxattr(
            file.as_raw_fd(),
            NAME.as_ptr(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
        )
    };
    if count < 0 {
        let error = io::Error::last_os_error();
        return if matches!(error.raw_os_error(), Some(libc::ENODATA | libc::EOPNOTSUPP)) {
            Ok(Acl(None))
        } else {
            Err(error)
        };
    }
    bytes.truncate(count as usize);
    Ok(Acl(Some(bytes)))
}
pub fn apply(acl: &Acl, file: &File) -> io::Result<()> {
    let result = match &acl.0 {
        Some(bytes) => unsafe {
            libc::fsetxattr(
                file.as_raw_fd(),
                NAME.as_ptr(),
                bytes.as_ptr().cast(),
                bytes.len(),
                0,
            )
        },
        None => unsafe { libc::fremovexattr(file.as_raw_fd(), NAME.as_ptr()) },
    };
    if result != 0 {
        let error = io::Error::last_os_error();
        if acl.0.is_some() || !matches!(error.raw_os_error(), Some(libc::ENODATA | libc::EOPNOTSUPP)) {
            return Err(error);
        }
    }
    Ok(())
}

pub fn privatize(file: &File) -> io::Result<()> {
    apply(&Acl(None), file)?;
    if read(file)? != Acl(None) {
        return Err(io::Error::other(
            "Staging ACL removal could not be verified",
        ));
    }
    Ok(())
}

#[allow(dead_code)]
pub fn inherit_directory(source: &File, target: &File) -> io::Result<()> {
    read(source)?;
    const DEFAULT: &std::ffi::CStr = c"system.posix_acl_default";
    let mut bytes = vec![0; 65536];
    let count = unsafe {
        libc::fgetxattr(
            source.as_raw_fd(),
            DEFAULT.as_ptr(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
        )
    };
    if count < 0 {
        let error = io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(libc::ENODATA | libc::EOPNOTSUPP)) {
            // The private probe may itself have inherited a temp-directory
            // default ACL. Absence at the real destination must remove it.
            if unsafe { libc::fremovexattr(target.as_raw_fd(), DEFAULT.as_ptr()) } != 0 {
                let error = io::Error::last_os_error();
                if !matches!(error.raw_os_error(), Some(libc::ENODATA | libc::EOPNOTSUPP)) {
                    return Err(error);
                }
            }
            return Ok(());
        }
        return Err(error);
    }
    if unsafe {
        libc::fsetxattr(
            target.as_raw_fd(),
            DEFAULT.as_ptr(),
            bytes.as_ptr().cast(),
            count as usize,
            0,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::fs::access_control::AccessControl;

    #[test]
    fn posix_acl_round_trip_or_explicit_unsupported_filesystem() {
        let source = tempfile::tempfile().unwrap();
        if let Err(error) = read(&source) {
            assert!(
                error.kind() == io::ErrorKind::Unsupported
                    || error.raw_os_error() == Some(libc::EOPNOTSUPP)
            );
            assert!(AccessControl::prepare_staging(&source).is_err());
            return;
        }
        // Linux's public POSIX ACL xattr format, with an explicit named user.
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
        if let Err(error) = apply(&Acl(Some(bytes.clone())), &source) {
            assert_eq!(error.raw_os_error(), Some(libc::EOPNOTSUPP));
            assert_eq!(read(&source).unwrap(), Acl(None));
            return;
        }
        let original = AccessControl::capture(&source).unwrap();
        let candidate = tempfile::tempfile().unwrap();
        AccessControl::prepare_staging(&candidate).unwrap();
        original.apply(&candidate).unwrap();
        assert_eq!(read(&candidate).unwrap(), Acl(Some(bytes)));
        privatize(&candidate).unwrap();
        assert_eq!(read(&candidate).unwrap(), Acl(None));
        assert!(original.verify(&candidate).is_err());
    }
}
