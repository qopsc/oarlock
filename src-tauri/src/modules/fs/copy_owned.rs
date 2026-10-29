//! Copy files and supported symbolic links using handles with atomic,
//! no-replace publication. Unsupported filesystems and entries fail safely.
use super::{
    attachment::handle_path,
    copy::{
        copy_destination, copy_name, CopyFailure, CopyResult, MAX_COPY_SOURCES, MAX_COPY_SUFFIX,
    },
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

// Kept behind the refusal while the destination-location race is unresolved.
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
fn publish(source: &fs::File, dest: &Dir, name: &std::ffi::OsStr) -> io::Result<()> {
    use std::os::{fd::AsRawFd, unix::ffi::OsStrExt};
    let name = std::ffi::CString::new(name.as_bytes()).map_err(io::Error::other)?;
    // fclonefileat addresses the opened file itself, requires a vacant target,
    // and atomically creates a copy. Unsupported volumes or cross-volume copies
    // return an error and do not fall back to a pathname-based publication.
    let result =
        unsafe { libc::fclonefileat(source.as_raw_fd(), dest.as_raw_fd(), name.as_ptr(), 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn publish(_source: &fs::File, _dest: &Dir, _name: &std::ffi::OsStr) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Safe file copying is unavailable on this platform",
    ))
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
    if !kind.is_file() && !(cfg!(target_os = "macos") && kind.is_symlink()) {
        return Err(io::Error::new(io::ErrorKind::Unsupported, "Only regular files and supported symbolic links can currently be copied safely; folders are unavailable"));
    }
    before_publish();
    for n in 0..=MAX_COPY_SUFFIX {
        let target = if n == 0 {
            name.to_os_string()
        } else {
            copy_name(name, n, false)
        };
        context.validate().map_err(io::Error::other)?;
        match publish(&file, context.dir, &target) {
            Ok(()) => return Ok(target),
            Err(error)
                if error.kind() == io::ErrorKind::AlreadyExists && context.rename_on_conflict =>
            {
                continue
            }
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::ENOTSUP) | Some(libc::EXDEV)
                ) =>
            {
                return Err(io::Error::new(io::ErrorKind::Unsupported, "Safe copying is unavailable across these volumes or on this filesystem; use your system file manager"));
            }
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "No free copy name",
    ))
}

#[cfg(test)]
#[path = "copy_owned_tests.rs"]
mod tests;
