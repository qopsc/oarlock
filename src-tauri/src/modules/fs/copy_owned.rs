//! Copy files and supported symbolic links using handles with atomic,
//! no-replace publication. Unsupported filesystems and entries fail safely.
#[cfg(target_os = "macos")]
use super::copy::{copy_name, MAX_COPY_SUFFIX};
use super::{
    attachment::handle_path,
    copy::{copy_destination, CopyFailure, CopyResult, MAX_COPY_SOURCES},
    index::FileIndexState,
    mutate::note_dir_changed,
    to_canon,
};
use crate::modules::workspace::{resolve_path, Origin, WorkspaceEnv, WorkspaceRegistry};
use cap_std::fs::Dir;
use std::{ffi::OsString, fs, io, path::Path};

pub(super) fn copy_batch(
    sources: Vec<String>,
    dest_dir: &str,
    root: &str,
    workspace: &WorkspaceEnv,
    registry: &WorkspaceRegistry,
    index: &FileIndexState,
    rename_on_conflict: bool,
) -> Result<CopyResult, String> {
    super::require_owned_entry_operation()?;
    copy_batch_impl(
        sources,
        dest_dir,
        root,
        workspace,
        registry,
        index,
        rename_on_conflict,
    )
}

// Workspace checks reject static escapes; unrelated same-user races are best effort.
fn copy_batch_impl(
    sources: Vec<String>,
    dest_dir: &str,
    root: &str,
    workspace: &WorkspaceEnv,
    registry: &WorkspaceRegistry,
    index: &FileIndexState,
    rename_on_conflict: bool,
) -> Result<CopyResult, String> {
    if sources.len() > MAX_COPY_SOURCES {
        return Err(format!("copy at most {MAX_COPY_SOURCES} items at a time"));
    }
    let destination = copy_destination(dest_dir, root, workspace, registry)?;
    let root = fs::canonicalize(resolve_path(root, workspace)?).map_err(|e| e.to_string())?;
    let dir = Dir::open_ambient_dir(&destination, cap_std::ambient_authority())
        .map_err(|e| e.to_string())?;
    let context = CopyContext {
        dir: &dir,
        destination: &destination,
        root: &root,
        registry,
        rename_on_conflict,
    };
    context.validate()?;
    let mut result = CopyResult::default();
    for source in sources {
        let copied = registry
            .gates(Origin::App)
            .authorized_entry(Path::new(&source))
            .and_then(|entry| copy_file(&entry, &context, || {}, || {}).map_err(|e| e.to_string()));
        match copied {
            Ok(name) => result
                .created
                .push(to_canon(Path::new(dest_dir).join(name))),
            Err(message) => result.failed.push(CopyFailure { source, message }),
        }
    }
    if !result.created.is_empty() {
        note_dir_changed(index, &destination);
    }
    Ok(result)
}

struct CopyContext<'a> {
    dir: &'a Dir,
    destination: &'a Path,
    root: &'a Path,
    registry: &'a WorkspaceRegistry,
    rename_on_conflict: bool,
}
impl CopyContext<'_> {
    fn validate(&self) -> Result<(), String> {
        let actual = handle_path(
            &self
                .dir
                .try_clone()
                .map_err(|e| e.to_string())?
                .into_std_file(),
        )?;
        if actual != self.destination
            || !actual.starts_with(self.root)
            || !self.registry.gates(Origin::App).reaches(&actual)
        {
            return Err("Copy destination changed or is outside the authorized workspace".into());
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn open_regular(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_SYMLINK | libc::O_NONBLOCK | libc::O_NOCTTY)
        .open(path)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_regular(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY)
        .open(path)
}

#[cfg(not(unix))]
fn open_regular(_path: &Path) -> io::Result<fs::File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Safe file copying is unavailable on this platform",
    ))
}

#[cfg(target_os = "macos")]
fn check_tree(path: &Path, registry: &WorkspaceRegistry, depth: usize) -> io::Result<()> {
    if depth > 128 {
        return Err(io::Error::other("Copy folder exceeds maximum depth"));
    }
    ensure_supported_mode(path)?;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let path = entry.path();
        let kind = fs::symlink_metadata(&path)?.file_type();
        if !kind.is_symlink() {
            ensure_supported_mode(&path)?;
        }
        if kind.is_symlink() {
            let target = fs::canonicalize(&path).map_err(|_| {
                io::Error::other("Cannot verify a symbolic link in the copied folder")
            })?;
            if !registry.gates(Origin::App).reaches(&target) {
                return Err(io::Error::other(
                    "A symbolic link in the copied folder escapes authorized folders",
                ));
            }
        } else if kind.is_dir() {
            check_tree(&path, registry, depth + 1)?;
        } else if !kind.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Copy folder contains an unsupported file type",
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_supported_mode(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if fs::symlink_metadata(path)?.permissions().mode() & 0o6000 != 0 {
        return Err(io::Error::new(io::ErrorKind::Unsupported,
            "Copying files with setuid or setgid permissions is unsupported because macOS cannot preserve them"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn stage_copy(source: &Path, dest: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    unsafe extern "C" {
        fn copyfile(
            from: *const libc::c_char,
            to: *const libc::c_char,
            state: *mut libc::c_void,
            flags: u32,
        ) -> libc::c_int;
    }
    let from = std::ffi::CString::new(source.as_os_str().as_bytes()).map_err(io::Error::other)?;
    let to = std::ffi::CString::new(dest.as_os_str().as_bytes()).map_err(io::Error::other)?;
    // COPYFILE_ALL includes ACLs, mode, extended attributes and data. Do not
    // follow symlinks, and never replace an existing staging entry.
    const FLAGS: u32 = 0xf | (1 << 15) | (1 << 17) | (1 << 18) | (1 << 19);
    if unsafe { copyfile(from.as_ptr(), to.as_ptr(), std::ptr::null_mut(), FLAGS) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
struct StagedCopy(super::private_staging::PrivateDirectory);
#[cfg(target_os = "macos")]
impl Drop for StagedCopy {
    fn drop(&mut self) {
        self.0.cleanup_content();
    }
}

fn copy_file(
    source: &Path,
    context: &CopyContext<'_>,
    after_open: impl FnOnce(),
    before_publish: impl FnOnce(),
) -> io::Result<OsString> {
    let name = source
        .file_name()
        .ok_or_else(|| io::Error::other("Copy source has no name"))?;
    let file = open_regular(source).map_err(|error| {
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return io::Error::new(
                io::ErrorKind::Unsupported,
                "Copying symbolic links is not yet supported safely",
            );
        }
        error
    })?;
    after_open();
    let actual = handle_path(&file).map_err(io::Error::other)?;
    if actual != source || !context.registry.gates(Origin::App).reaches(&actual) {
        return Err(io::Error::other(
            "Copy source changed or is outside the authorized folders",
        ));
    }
    let kind = file.metadata()?.file_type();
    #[cfg(target_os = "macos")]
    {
        if kind.is_dir() {
            if context.destination.starts_with(source) {
                return Err(io::Error::other("Cannot copy a folder into itself"));
            }
            check_tree(source, context.registry, 0)?;
        } else if kind.is_file() {
            ensure_supported_mode(source)?;
        } else if !kind.is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Unsupported copy source",
            ));
        }
        let staged = StagedCopy(super::private_staging::PrivateDirectory::for_destination(
            context.dir,
        )?);
        let staged_path = staged.0.content_path()?;
        stage_copy(source, &staged_path)?;
        before_publish();
        for n in 0..=MAX_COPY_SUFFIX {
            let target = if n == 0 {
                name.to_os_string()
            } else {
                copy_name(name, n, kind.is_dir())
            };
            context.validate().map_err(io::Error::other)?;
            staged.0.verify()?;
            match super::mutate::rename_no_replace(&staged_path, &context.destination.join(&target))
            {
                Ok(()) => return Ok(target),
                Err(error)
                    if error.kind() == io::ErrorKind::AlreadyExists
                        && context.rename_on_conflict =>
                {
                    continue
                }
                Err(error) => return Err(error),
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (kind, before_publish, name);
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Metadata-preserving copying is unavailable on this platform",
        ));
    }

    #[cfg(target_os = "macos")]
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "No free copy name",
    ))
}

#[cfg(test)]
#[path = "copy_owned_tests.rs"]
mod tests;
