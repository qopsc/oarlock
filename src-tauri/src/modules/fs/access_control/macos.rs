use std::{ffi::c_void, fs::File, io, os::fd::AsRawFd, ptr};

// Darwin's filesec API distinguishes explicit absence from acl_get_fd's ENOENT.
// Opaque allocations never cross threads; snapshots contain only external bytes.
unsafe extern "C" {
    fn filesec_init() -> *mut c_void;
    fn filesec_free(value: *mut c_void);
    fn filesec_query_property(value: *mut c_void, property: i32, present: *mut i32) -> i32;
    fn filesec_get_property(value: *mut c_void, property: i32, result: *mut c_void) -> i32;
    #[cfg_attr(target_arch = "x86_64", link_name = "fstatx_np$INODE64")]
    fn fstatx_np(fd: i32, state: *mut libc::stat, value: *mut c_void) -> i32;
    fn acl_free(value: *mut c_void) -> i32;
    fn acl_size(value: *mut c_void) -> isize;
    fn acl_copy_ext(bytes: *mut c_void, value: *mut c_void, size: isize) -> isize;
    fn acl_copy_int(bytes: *const c_void) -> *mut c_void;
    fn acl_set_fd(fd: i32, value: *mut c_void) -> i32;
    fn acl_get_entry(acl: *mut c_void, entry_id: i32, entry: *mut *mut c_void) -> i32;
    fn acl_get_tag_type(entry: *mut c_void, tag: *mut i32) -> i32;
    fn acl_get_permset_mask_np(entry: *mut c_void, permissions: *mut u64) -> i32;
}
const FILESEC_ACL: i32 = 5;

struct Security(*mut c_void);
impl Drop for Security {
    fn drop(&mut self) {
        unsafe { filesec_free(self.0) }
    }
}
struct NativeAcl(*mut c_void);
impl Drop for NativeAcl {
    fn drop(&mut self) {
        unsafe {
            acl_free(self.0);
        }
    }
}
#[derive(Debug, PartialEq, Eq)]
pub struct Acl(Option<Vec<u8>>);

pub fn read(file: &File) -> io::Result<Acl> {
    let security = Security(unsafe { filesec_init() });
    if security.0.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut state = std::mem::MaybeUninit::<libc::stat>::uninit();
    let mut present = 0;
    if unsafe { fstatx_np(file.as_raw_fd(), state.as_mut_ptr(), security.0) } != 0
        || unsafe { filesec_query_property(security.0, FILESEC_ACL, &mut present) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if present == 0 {
        return Ok(Acl(None));
    }
    let mut raw: *mut c_void = ptr::null_mut();
    if unsafe {
        filesec_get_property(
            security.0,
            FILESEC_ACL,
            (&mut raw as *mut *mut c_void).cast(),
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if raw.is_null() {
        return Err(io::Error::other("Missing native ACL"));
    }
    let acl = NativeAcl(raw);
    let size = unsafe { acl_size(acl.0) };
    if !(1..=1024 * 1024).contains(&size) {
        return Err(io::Error::other("Unsupported native ACL size"));
    }
    let mut bytes = vec![0; size as usize];
    if unsafe { acl_copy_ext(bytes.as_mut_ptr().cast(), acl.0, size) } != size {
        return Err(io::Error::other(
            "Could not capture the complete native ACL",
        ));
    }
    Ok(Acl(Some(bytes)))
}

fn apply_with_policy(acl: &Acl, file: &File, require_cleanup: bool) -> io::Result<()> {
    let result = if let Some(bytes) = &acl.0 {
        let native = NativeAcl(unsafe { acl_copy_int(bytes.as_ptr().cast()) });
        if native.0.is_null() {
            return Err(io::Error::last_os_error());
        }
        // Rename and failed-operation cleanup both need to remove this staging
        // entry. Refuse rules that could prohibit that before installing them.
        for i in 0..=128 {
            let mut entry = ptr::null_mut();
            if unsafe { acl_get_entry(native.0, if i == 0 { 0 } else { -1 }, &mut entry) } != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINVAL) {
                    break;
                }
                return Err(error);
            }
            if i == 128 {
                return Err(io::Error::other("Unsupported ACL entry count"));
            }
            let mut tag = 0;
            let mut permissions = 0;
            if unsafe { acl_get_tag_type(entry, &mut tag) } != 0
                || unsafe { acl_get_permset_mask_np(entry, &mut permissions) } != 0
            {
                return Err(io::Error::last_os_error());
            }
            if require_cleanup && tag == 2 && permissions & (1 << 4) != 0 {
                return Err(io::Error::new(io::ErrorKind::Unsupported,
                    "Atomic replacement cannot safely preserve a deny-delete ACL; original file unchanged"));
            }
        }
        unsafe { acl_set_fd(file.as_raw_fd(), native.0) }
    } else {
        // Darwin _FILESEC_REMOVE_ACL: remove inherited rules on the staging
        // file when the original explicitly had none. Never leave them behind.
        unsafe { acl_set_fd(file.as_raw_fd(), ptr::without_provenance_mut(1)) }
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn apply(acl: &Acl, file: &File) -> io::Result<()> {
    apply_with_policy(acl, file, true)
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

pub fn inherit_directory(source: &File, target: &File) -> io::Result<()> {
    // The enclosing private directory already prevents access to this empty
    // inheritance probe. Kernel file creation performs the inheritance itself.
    apply_with_policy(&read(source)?, target, false)
}
