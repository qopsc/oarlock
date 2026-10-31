//! These probes demonstrate why parent-directory ownership alone is not an
//! adequate implementation of the guarded native mutation commands.
use cap_std::fs::Dir;
use std::{fs, io::Read};

#[test]
fn pinned_directory_rename_moves_a_replaced_entry_not_the_opened_file() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = Dir::open_ambient_dir(tmp.path(), cap_std::ambient_authority()).unwrap();
    fs::write(tmp.path().join("selected"), "selected").unwrap();
    fs::write(tmp.path().join("replacement"), "replacement").unwrap();
    let mut opened = dir.open("selected").unwrap();
    fs::rename(tmp.path().join("selected"), tmp.path().join("original")).unwrap();
    fs::rename(tmp.path().join("replacement"), tmp.path().join("selected")).unwrap();

    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        let selected = std::ffi::CString::new("selected").unwrap();
        let moved = std::ffi::CString::new("moved").unwrap();
        let result = unsafe {
            libc::renameatx_np(
                dir.as_raw_fd(),
                selected.as_ptr(),
                dir.as_raw_fd(),
                moved.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        assert_eq!(result, 0, "{}", std::io::Error::last_os_error());
    }
    #[cfg(not(target_os = "macos"))]
    dir.rename("selected", &dir, "moved").unwrap();
    let mut held = String::new();
    opened.read_to_string(&mut held).unwrap();
    assert_eq!(held, "selected");
    assert_eq!(
        fs::read_to_string(tmp.path().join("moved")).unwrap(),
        "replacement"
    );
}

#[test]
fn pinned_directory_unlink_removes_a_replaced_entry_not_the_opened_file() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = Dir::open_ambient_dir(tmp.path(), cap_std::ambient_authority()).unwrap();
    fs::write(tmp.path().join("selected"), "selected").unwrap();
    fs::write(tmp.path().join("replacement"), "replacement").unwrap();
    let mut opened = dir.open("selected").unwrap();
    fs::rename(tmp.path().join("selected"), tmp.path().join("original")).unwrap();
    fs::rename(tmp.path().join("replacement"), tmp.path().join("selected")).unwrap();

    dir.remove_file("selected").unwrap();
    let mut held = String::new();
    opened.read_to_string(&mut held).unwrap();
    assert_eq!(held, "selected");
    assert!(!tmp.path().join("selected").exists());
    assert_eq!(
        fs::read_to_string(tmp.path().join("original")).unwrap(),
        "selected"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn nodeletebusy_does_not_bind_the_named_entry_to_the_open_file() {
    use std::os::fd::AsRawFd;

    // Apple's fcntl.h defines AT_NODELETEBUSY as 0x4000. It refuses an open
    // file, but does not compare the pathname with a particular open handle.
    const AT_NODELETEBUSY: libc::c_int = 0x4000;
    let tmp = tempfile::tempdir().unwrap();
    let dir = Dir::open_ambient_dir(tmp.path(), cap_std::ambient_authority()).unwrap();
    fs::write(tmp.path().join("selected"), "selected").unwrap();
    fs::write(tmp.path().join("replacement"), "replacement").unwrap();
    let _opened = dir.open("selected").unwrap();
    let name = std::ffi::CString::new("selected").unwrap();
    let unlink = || unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), AT_NODELETEBUSY) };

    assert_eq!(unlink(), -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::EBUSY)
    );
    fs::rename(tmp.path().join("selected"), tmp.path().join("original")).unwrap();
    fs::rename(tmp.path().join("replacement"), tmp.path().join("selected")).unwrap();
    assert_eq!(unlink(), 0);
    assert_eq!(
        fs::read_to_string(tmp.path().join("original")).unwrap(),
        "selected"
    );
    assert!(!tmp.path().join("selected").exists());
}

#[cfg(target_os = "macos")]
#[test]
fn seclude_rename_does_not_bind_the_named_entry_to_the_open_file() {
    use std::os::fd::AsRawFd;
    // sys/stdio.h defines RENAME_SECLUDE as 1. It does not accept an
    // expected source-file handle or identity.
    const RENAME_SECLUDE: libc::c_uint = 1;
    let tmp = tempfile::tempdir().unwrap();
    let dir = Dir::open_ambient_dir(tmp.path(), cap_std::ambient_authority()).unwrap();
    fs::write(tmp.path().join("selected"), "selected").unwrap();
    fs::write(tmp.path().join("replacement"), "replacement").unwrap();
    let mut opened = dir.open("selected").unwrap();
    fs::rename(tmp.path().join("selected"), tmp.path().join("original")).unwrap();
    fs::rename(tmp.path().join("replacement"), tmp.path().join("selected")).unwrap();
    let selected = std::ffi::CString::new("selected").unwrap();
    let moved = std::ffi::CString::new("moved").unwrap();
    let result = unsafe {
        libc::renameatx_np(
            dir.as_raw_fd(),
            selected.as_ptr(),
            dir.as_raw_fd(),
            moved.as_ptr(),
            RENAME_SECLUDE,
        )
    };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        assert!(matches!(
            error.raw_os_error(),
            Some(libc::ENOTSUP) | Some(libc::EOPNOTSUPP)
        ));
        assert_eq!(
            fs::read_to_string(tmp.path().join("selected")).unwrap(),
            "replacement"
        );
        return;
    }
    let mut held = String::new();
    opened.read_to_string(&mut held).unwrap();
    assert_eq!(held, "selected");
    assert_eq!(
        fs::read_to_string(tmp.path().join("moved")).unwrap(),
        "replacement"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn beneath_and_nofollow_rename_still_moves_a_replacement_entry() {
    use std::os::fd::AsRawFd;

    // These flags restrict path traversal; neither compares the source entry
    // with an already-open file handle.
    const RENAME_NOFOLLOW_ANY: libc::c_uint = 0x10;
    const RENAME_RESOLVE_BENEATH: libc::c_uint = 0x20;
    let tmp = tempfile::tempdir().unwrap();
    let dir = Dir::open_ambient_dir(tmp.path(), cap_std::ambient_authority()).unwrap();
    fs::write(tmp.path().join("selected"), "selected").unwrap();
    fs::write(tmp.path().join("replacement"), "replacement").unwrap();
    let mut opened = dir.open("selected").unwrap();
    fs::rename(tmp.path().join("selected"), tmp.path().join("original")).unwrap();
    fs::rename(tmp.path().join("replacement"), tmp.path().join("selected")).unwrap();
    let selected = std::ffi::CString::new("selected").unwrap();
    let moved = std::ffi::CString::new("moved").unwrap();
    let result = unsafe {
        libc::renameatx_np(
            dir.as_raw_fd(),
            selected.as_ptr(),
            dir.as_raw_fd(),
            moved.as_ptr(),
            libc::RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH,
        )
    };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        assert!(matches!(
            error.raw_os_error(),
            Some(libc::EINVAL) | Some(libc::ENOTSUP) | Some(libc::EOPNOTSUPP)
        ));
        assert_eq!(
            fs::read_to_string(tmp.path().join("selected")).unwrap(),
            "replacement"
        );
        assert!(!tmp.path().join("moved").exists());
        return;
    }
    let mut held = String::new();
    opened.read_to_string(&mut held).unwrap();
    assert_eq!(held, "selected");
    assert_eq!(
        fs::read_to_string(tmp.path().join("moved")).unwrap(),
        "replacement"
    );
}
