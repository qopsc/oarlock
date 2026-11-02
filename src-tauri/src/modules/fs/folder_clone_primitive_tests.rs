//! Investigative tests of macOS directory cloning. These do not enable folder
//! copy or assert a consistent snapshot of a changing directory hierarchy.
use std::{fs, io, os::fd::AsRawFd, os::unix::fs::symlink, path::Path};

fn clone_from_handle(src: &fs::File, dest: &fs::File, name: &str) -> io::Result<()> {
    let name = std::ffi::CString::new(name).unwrap();
    let result = unsafe { libc::fclonefileat(src.as_raw_fd(), dest.as_raw_fd(), name.as_ptr(), 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[test]
fn directory_clone_uses_open_source_and_retains_nested_symlinks() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let source = root.join("source");
    let dest = root.join("destination");
    let outside = root.join("outside");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&dest).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(source.join("public"), "public").unwrap();
    fs::write(outside.join("secret"), "secret").unwrap();
    symlink(&outside, source.join("link")).unwrap();
    let source_fd = fs::File::open(&source).unwrap();
    let dest_fd = fs::File::open(&dest).unwrap();
    fs::rename(&source, root.join("original")).unwrap();
    symlink(&outside, &source).unwrap();

    match clone_from_handle(&source_fd, &dest_fd, "copy") {
        Ok(()) => {
            assert_eq!(
                fs::read_to_string(dest.join("copy/public")).unwrap(),
                "public"
            );
            assert_eq!(fs::read_link(dest.join("copy/link")).unwrap(), outside);
            assert!(!dest.join("copy/secret").exists());
        }
        Err(error) if error.raw_os_error() == Some(libc::ENOTSUP) => {
            assert!(fs::symlink_metadata(dest.join("copy")).is_err());
        }
        Err(error) => panic!("unexpected directory-clone failure: {error}"),
    }
}

#[test]
fn directory_clone_does_not_replace_a_conflicting_symlink() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let source = root.join("source");
    let dest = root.join("destination");
    let outside = root.join("outside");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&dest).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep"), "keep").unwrap();
    symlink(&outside, dest.join("copy")).unwrap();
    let source_fd = fs::File::open(&source).unwrap();
    let dest_fd = fs::File::open(&dest).unwrap();

    assert!(clone_from_handle(&source_fd, &dest_fd, "copy").is_err());
    assert_eq!(fs::read_link(dest.join("copy")).unwrap(), outside);
    assert_eq!(fs::read_to_string(outside.join("keep")).unwrap(), "keep");
    assert!(!Path::new(&outside).join("source").exists());
}

#[test]
fn cloning_a_directory_with_an_unreadable_file_leaves_no_destination() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source");
    let dest = tmp.path().join("destination");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&dest).unwrap();
    let denied = source.join("denied");
    fs::write(&denied, "private").unwrap();
    fs::set_permissions(&denied, fs::Permissions::from_mode(0o0)).unwrap();
    struct RestorePermissions(std::path::PathBuf);
    impl Drop for RestorePermissions {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o600));
        }
    }
    let _restore = RestorePermissions(denied.clone());
    assert_eq!(
        fs::File::open(&denied).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    let source_fd = fs::File::open(&source).unwrap();
    let dest_fd = fs::File::open(&dest).unwrap();
    assert!(clone_from_handle(&source_fd, &dest_fd, "copy").is_err());
    assert!(fs::symlink_metadata(dest.join("copy")).is_err());
}

#[test]
fn cloning_a_directory_into_its_own_child_leaves_no_destination() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source");
    let child = source.join("child");
    fs::create_dir_all(&child).unwrap();
    fs::write(child.join("file"), "data").unwrap();
    let source_fd = fs::File::open(&source).unwrap();
    let child_fd = fs::File::open(&child).unwrap();
    assert!(clone_from_handle(&source_fd, &child_fd, "copy").is_err());
    assert!(fs::symlink_metadata(child.join("copy")).is_err());
    assert_eq!(fs::read_to_string(child.join("file")).unwrap(), "data");
}

#[test]
fn bounded_concurrent_swaps_do_not_observe_an_impossible_clone() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source");
    let dest = tmp.path().join("destination");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&dest).unwrap();
    fs::write(source.join("a"), "A").unwrap();
    fs::write(source.join("b"), "B").unwrap();
    for i in 0..32 {
        fs::write(source.join(format!("filler-{i:02}")), "x").unwrap();
    }
    let source_fd = fs::File::open(&source).unwrap();
    let dest_fd = fs::File::open(&dest).unwrap();
    let stop = AtomicBool::new(false);
    let swaps = AtomicUsize::new(0);
    let ready = std::sync::Barrier::new(2);
    let first = std::ffi::CString::new("a").unwrap();
    let second = std::ffi::CString::new("b").unwrap();

    struct StopOnDrop<'a>(&'a AtomicBool);
    impl Drop for StopOnDrop<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }
    std::thread::scope(|scope| {
        let _stop_on_unwind = StopOnDrop(&stop);
        let worker = scope.spawn(|| {
            let status = unsafe {
                libc::renameatx_np(
                    source_fd.as_raw_fd(),
                    first.as_ptr(),
                    source_fd.as_raw_fd(),
                    second.as_ptr(),
                    libc::RENAME_SWAP,
                )
            };
            let initial_error = (status != 0).then(io::Error::last_os_error);
            if initial_error.is_none() {
                swaps.fetch_add(1, Ordering::Relaxed);
            }
            ready.wait();
            if let Some(error) = initial_error {
                return Err(error);
            }
            while !stop.load(Ordering::Relaxed) {
                let status = unsafe {
                    libc::renameatx_np(
                        source_fd.as_raw_fd(),
                        first.as_ptr(),
                        source_fd.as_raw_fd(),
                        second.as_ptr(),
                        libc::RENAME_SWAP,
                    )
                };
                if status != 0 {
                    return Err(io::Error::last_os_error());
                }
                swaps.fetch_add(1, Ordering::Relaxed);
            }
            Ok(())
        });
        ready.wait();
        let mut unexpected = None;
        for i in 0..64 {
            let name = format!("copy-{i}");
            match clone_from_handle(&source_fd, &dest_fd, &name) {
                Ok(()) => {
                    let copy = dest.join(&name);
                    let a = fs::read_to_string(copy.join("a")).unwrap();
                    let b = fs::read_to_string(copy.join("b")).unwrap();
                    if !((a == "A" && b == "B") || (a == "B" && b == "A")) {
                        unexpected = Some((a, b));
                    }
                    fs::remove_dir_all(copy).unwrap();
                    if unexpected.is_some() {
                        break;
                    }
                }
                Err(error) if error.raw_os_error() == Some(libc::ENOTSUP) => break,
                Err(error) => panic!("unexpected directory-clone failure: {error}"),
            }
        }
        stop.store(true, Ordering::Relaxed);
        worker.join().unwrap().unwrap();
        assert!(swaps.load(Ordering::Relaxed) > 0);
        assert!(
            unexpected.is_none(),
            "clone contained a combination that never existed: {unexpected:?}"
        );
    });
}
