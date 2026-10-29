//! Descriptor-bound extended metadata. Unknown/content-dependent attributes fail
//! closed: copying compression or code-signing state onto new bytes is unsafe.
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::fd::AsRawFd;
use std::{
    collections::BTreeMap,
    ffi::{CStr, CString},
    fs::File,
    io,
};

const MAX_NAMES: usize = 64 * 1024;
const MAX_VALUE: usize = 1024 * 1024;
const MAX_TOTAL: usize = 8 * 1024 * 1024;
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Extended {
    values: BTreeMap<CString, Vec<u8>>,
    #[cfg(target_os = "macos")]
    flags: u32,
}
fn unsupported() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "Extended file metadata cannot be preserved safely; file not replaced",
    )
}
fn bounded_read(
    limit: usize,
    mut read: impl FnMut(*mut u8, usize) -> isize,
) -> io::Result<Vec<u8>> {
    let count = read(std::ptr::null_mut(), 0);
    if count < 0 {
        return Err(io::Error::last_os_error());
    }
    if count as usize > limit {
        return Err(unsupported());
    }
    // Even a zero-length value/list must be read again to detect growth.
    let mut bytes = vec![0; (count as usize).max(1)];
    let actual = read(bytes.as_mut_ptr(), bytes.len());
    if actual < 0 {
        return Err(io::Error::last_os_error());
    }
    if actual != count {
        return Err(io::Error::other(
            "Extended metadata changed during capture; retry the save",
        ));
    }
    bytes.truncate(count as usize);
    Ok(bytes)
}
fn names(file: &File) -> io::Result<Vec<CString>> {
    let bytes = bounded_read(MAX_NAMES, |buffer, size| {
        #[cfg(target_os = "macos")]
        {
            unsafe {
                libc::flistxattr(
                    file.as_raw_fd(),
                    buffer.cast(),
                    size,
                    libc::XATTR_SHOWCOMPRESSION,
                )
            }
        }
        #[cfg(target_os = "linux")]
        {
            unsafe { libc::flistxattr(file.as_raw_fd(), buffer.cast(), size) }
        }
    })?;
    if !bytes.is_empty() && bytes.last() != Some(&0) {
        return Err(unsupported());
    }
    bytes
        .split_inclusive(|b| *b == 0)
        .map(|name| {
            if name.len() < 2 {
                return Err(unsupported());
            }
            CString::from_vec_with_nul(name.to_vec()).map_err(|_| unsupported())
        })
        .collect()
}
fn managed_by_acl(name: &CStr) -> bool {
    cfg!(target_os = "linux") && name.to_bytes() == b"system.posix_acl_access"
}
fn supported(name: &CStr) -> bool {
    let bytes = name.to_bytes();
    if bytes.starts_with(b"user.") {
        return true;
    }
    cfg!(target_os = "macos")
        && (bytes.starts_with(b"com.apple.metadata:")
            || matches!(
                bytes,
                b"com.apple.quarantine"
                    | b"com.apple.provenance"
                    | b"com.apple.FinderInfo"
                    | b"com.apple.ResourceFork"
            ))
}
fn value(file: &File, name: &CStr, limit: usize) -> io::Result<Vec<u8>> {
    bounded_read(limit, |buffer, size| {
        #[cfg(target_os = "macos")]
        {
            unsafe {
                libc::fgetxattr(
                    file.as_raw_fd(),
                    name.as_ptr(),
                    buffer.cast(),
                    size,
                    0,
                    libc::XATTR_SHOWCOMPRESSION,
                )
            }
        }
        #[cfg(target_os = "linux")]
        {
            unsafe { libc::fgetxattr(file.as_raw_fd(), name.as_ptr(), buffer.cast(), size) }
        }
    })
}
fn set(file: &File, name: &CStr, value: Option<&[u8]>) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    let result = unsafe {
        match value {
            Some(bytes) => libc::fsetxattr(
                file.as_raw_fd(),
                name.as_ptr(),
                bytes.as_ptr().cast(),
                bytes.len(),
                0,
                0,
            ),
            None => libc::fremovexattr(file.as_raw_fd(), name.as_ptr(), 0),
        }
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        match value {
            Some(bytes) => libc::fsetxattr(
                file.as_raw_fd(),
                name.as_ptr(),
                bytes.as_ptr().cast(),
                bytes.len(),
                0,
            ),
            None => libc::fremovexattr(file.as_raw_fd(), name.as_ptr()),
        }
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
impl Extended {
    pub fn capture(file: &File) -> io::Result<Self> {
        #[cfg(target_os = "macos")]
        let flags = {
            use std::os::macos::fs::MetadataExt;
            let flags = file.metadata()?.st_flags();
            if flags & !(libc::UF_HIDDEN | libc::UF_NODUMP) != 0 {
                return Err(unsupported());
            }
            flags
        };
        let mut values = BTreeMap::new();
        let mut remaining = MAX_TOTAL;
        for name in names(file)? {
            if managed_by_acl(&name) {
                continue;
            }
            if !supported(&name) {
                return Err(unsupported());
            }
            let bytes = value(file, &name, remaining.min(MAX_VALUE))?;
            remaining -= bytes.len();
            if values.insert(name, bytes).is_some() {
                return Err(unsupported());
            }
        }
        Ok(Self {
            values,
            #[cfg(target_os = "macos")]
            flags,
        })
    }
    pub fn apply(&self, file: &File) -> io::Result<()> {
        // Inspect before changing anything, including unsupported inherited state.
        let current = Self::capture(file)?;
        for name in current.values.keys() {
            if !self.values.contains_key(name) {
                set(file, name, None)?;
            }
        }
        for (name, bytes) in &self.values {
            set(file, name, Some(bytes))?;
        }
        #[cfg(target_os = "macos")]
        if unsafe { libc::fchflags(file.as_raw_fd(), self.flags) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if Self::capture(file)? != *self {
            return Err(io::Error::other(
                "Extended metadata preservation could not be verified; file not replaced",
            ));
        }
        Ok(())
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;
    #[test]
    fn attributes_are_exact_and_unknown_metadata_is_refused() {
        let source = tempfile::tempfile().unwrap();
        let target = tempfile::tempfile().unwrap();
        set(&source, c"user.oarlock-test", Some(b"value\0bytes")).unwrap();
        set(&source, c"user.empty", Some(b"")).unwrap();
        set(&target, c"user.stale", Some(b"stale")).unwrap();
        let captured = Extended::capture(&source).unwrap();
        captured.apply(&target).unwrap();
        assert_eq!(Extended::capture(&target).unwrap(), captured);
        set(&source, c"user.oarlock-test", Some(b"changed")).unwrap();
        assert_ne!(Extended::capture(&source).unwrap(), captured);
        #[cfg(target_os = "macos")]
        {
            set(&source, c"com.oarlock.unsupported", Some(b"unsupported")).unwrap();
            assert!(Extended::capture(&source).is_err());
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn supported_file_flags_are_preserved() {
        let source = tempfile::tempfile().unwrap();
        let target = tempfile::tempfile().unwrap();
        assert_eq!(
            unsafe { libc::fchflags(source.as_raw_fd(), libc::UF_HIDDEN | libc::UF_NODUMP) },
            0
        );
        let captured = Extended::capture(&source).unwrap();
        captured.apply(&target).unwrap();
        assert_eq!(Extended::capture(&target).unwrap(), captured);
    }
    #[test]
    fn changed_oversized_or_failed_reads_are_not_empty_metadata() {
        assert!(bounded_read(16, |_, _| 17).is_err());
        let mut first = true;
        assert!(bounded_read(16, |_, _| {
            if first {
                first = false;
                0
            } else {
                1
            }
        })
        .is_err());
        assert!(bounded_read(16, |_, _| -1).is_err());
    }
}
