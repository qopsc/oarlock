//! Startup-only, recoverable adoption. The registry is published last; no page
//! or plugin store may load until recovery succeeds. Renames preserve metadata.
//! Every displaced item remains in the private journal until the commit is durable.
use super::{
    active_chat_key, data_root, is_app_window, restore_plan, spaces_store, terminal_scrollback,
    RegistryFile, RestorePlan, CHAT_STORE, MAIN, REGISTRY_FILE,
};
use crate::modules::fs::access_control::AccessControl;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use cap_std::fs::Dir;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const JOURNAL: &str = ".oarlock-window-restore";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    from: String,
    items: Vec<Item>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Item {
    source: Option<String>,
    previous: Option<String>,
}

fn fail(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}

#[cfg(unix)]
fn pin_root(root: &Path) -> io::Result<Dir> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = OpenOptions::new().read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)?;
    Ok(Dir::from_std_file(file))
}

#[cfg(not(unix))]
fn pin_root(_: &Path) -> io::Result<Dir> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "Safe window-state storage is unavailable"))
}

fn relative<'a>(root: &Path, path: &'a Path) -> io::Result<&'a Path> {
    path.strip_prefix(root).map_err(|_| fail("Window state path left its root"))
}

// Resolve one component at a time from the retained data directory. No
// component may be a link, and file contents are read only after identity is checked.
#[cfg(unix)]
fn open_child(parent: &Dir, name: &std::ffi::OsStr, directory: bool) -> io::Result<File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    let name_bytes =
        CString::new(name.as_bytes()).map_err(|_| fail("Invalid window state name"))?;
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | libc::O_CLOEXEC
        | if directory { libc::O_DIRECTORY } else { 0 };
    let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name_bytes.as_ptr(), flags) };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    let metadata = file.metadata()?;
    if (directory && !metadata.is_dir())
        || (!directory && (!metadata.is_file() || metadata.nlink() != 1))
        || !crate::modules::fs::file_identity::entry_matches(parent, Path::new(name), &file)?
    {
        return Err(fail(
            "Window state entry is linked, changed, or has the wrong type",
        ));
    }
    Ok(file)
}

#[cfg(not(unix))]
fn open_child(_: &Dir, _: &std::ffi::OsStr, _: bool) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Safe window-state storage is unavailable",
    ))
}

fn open_parent(owner: &Dir, root: &Path, path: &Path) -> io::Result<(Dir, std::ffi::OsString)> {
    use std::path::Component;
    let relative = relative(root, path)?;
    let name = relative
        .file_name()
        .ok_or_else(|| fail("Missing window state name"))?
        .to_owned();
    let mut directory = owner.try_clone()?;
    for component in relative
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .components()
    {
        let Component::Normal(name) = component else {
            return Err(fail("Invalid window state path"));
        };
        directory = Dir::from_std_file(open_child(&directory, name, true)?);
    }
    Ok((directory, name))
}

fn open_file(owner: &Dir, root: &Path, path: &Path) -> io::Result<File> {
    let (parent, name) = open_parent(owner, root, path)?;
    open_child(&parent, &name, false)
}

fn open_directory(owner: &Dir, root: &Path, path: &Path) -> io::Result<Dir> {
    if path == root {
        return owner.try_clone();
    }
    let (parent, name) = open_parent(owner, root, path)?;
    Ok(Dir::from_std_file(open_child(&parent, &name, true)?))
}

// Hash incrementally: adoption does not load scrollback into memory.
fn fingerprint(owner: &Dir, root: &Path, path: &Path) -> io::Result<Option<String>> {
    fn visit(
        parent: &Dir,
        name: &std::ffi::OsStr,
        hash: &mut Sha256,
        depth: usize,
    ) -> io::Result<()> {
        if depth > 128 {
            return Err(fail("Window state directory nesting is excessive"));
        }
        let meta = parent.symlink_metadata(name)?;
        if meta.is_file() {
            let mut file = open_child(parent, name, false)?;
            hash.update(b"file");
            hash.update(file.metadata()?.len().to_le_bytes());
            let mut bytes = [0; 64 * 1024];
            loop {
                let n = file.read(&mut bytes)?;
                if n == 0 {
                    break;
                }
                hash.update(&bytes[..n]);
            }
        } else if meta.is_dir() {
            let dir = Dir::from_std_file(open_child(parent, name, true)?);
            hash.update(b"directory");
            let mut names = dir
                .entries()?
                .map(|entry| entry.map(|entry| entry.file_name()))
                .collect::<io::Result<Vec<_>>>()?;
            names.sort();
            for name in names {
                let bytes = name.as_encoded_bytes();
                hash.update((bytes.len() as u64).to_le_bytes());
                hash.update(bytes);
                visit(&dir, &name, hash, depth + 1)?;
            }
            hash.update(b"end");
        } else {
            return Err(fail("Unsupported window state entry"));
        }
        Ok(())
    }
    let (parent, name) = match open_parent(owner, root, path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        result => result?,
    };
    match parent.symlink_metadata(&name) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        result => {
            result?;
        }
    }
    let mut hash = Sha256::new();
    visit(&parent, &name, &mut hash, 0)?;
    Ok(Some(format!("{:x}", hash.finalize())))
}
fn sync_dir(owner: &Dir, root: &Path, path: &Path) -> io::Result<()> {
    open_directory(owner, root, path)?
        .into_std_file()
        .sync_all()
}
fn write_new(
    owner: &Dir,
    root: &Path,
    path: &Path,
    bytes: &[u8],
    previous: Option<&Path>,
) -> io::Result<()> {
    let (parent, name) = open_parent(owner, root, path)?;
    let mut options = cap_std::fs::OpenOptions::new();
    options.write(true).read(true).create_new(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut file = parent.open_with(&name, &options)?.into_std();
    if !crate::modules::fs::file_identity::entry_matches(&parent, Path::new(&name), &file)? {
        return Err(fail("Window state candidate changed during creation"));
    }
    file.write_all(bytes)?;
    if let Some(previous) = previous {
        AccessControl::capture(&open_file(owner, root, previous)?)?.apply(&file)?;
    }
    file.sync_all()
}
fn read_json_at(owner: &Dir, root: &Path, path: &Path) -> io::Result<Option<serde_json::Value>> {
    let mut file = match open_file(owner, root, path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(Some(serde_json::from_slice(&bytes)?))
}
#[cfg(test)]
fn read_json(path: &Path) -> io::Result<Option<serde_json::Value>> {
    let root = path.parent().ok_or_else(|| fail("Missing state parent"))?;
    read_json_at(&pin_root(root)?, root, path)
}
#[cfg(test)]
pub(super) fn read_registry(path: &Path) -> io::Result<Vec<String>> {
    let root = path.parent().ok_or_else(|| fail("Missing state parent"))?;
    read_registry_at(&pin_root(root)?, root, path)
}
fn read_registry_at(owner: &Dir, root: &Path, path: &Path) -> io::Result<Vec<String>> {
    match read_json_at(owner, root, path)? {
        None => Ok(Vec::new()),
        Some(value) => Ok(serde_json::from_value::<RegistryFile>(value)?.windows),
    }
}
fn paths(root: &Path, journal: &Path, from: &str) -> [(PathBuf, PathBuf); 4] {
    [
        (root.join(spaces_store(from)), root.join(spaces_store(MAIN))),
        (
            terminal_scrollback::directory(&data_root(root, from)),
            terminal_scrollback::directory(root),
        ),
        (journal.join("chat"), root.join(CHAT_STORE)),
        (journal.join("registry"), root.join(REGISTRY_FILE)),
    ]
}
fn validate_source_directories(owner: &Dir, root: &Path, from: &str) -> io::Result<()> {
    for directory in [root.join(super::WINDOWS_DIRECTORY), data_root(root, from)] {
        match open_directory(owner, root, &directory) {
            Ok(_) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
fn prepare(root: &Path, plan: &RestorePlan) -> io::Result<()> {
    let owner = pin_root(root)?;
    if !cfg!(any(target_os = "macos", target_os = "linux")) {
        return Err(io::Error::new(io::ErrorKind::Unsupported,
            "Safe window-state migration requires private staging and metadata preservation, which are not supported on this platform yet"));
    }
    let from = plan
        .adopt
        .as_ref()
        .ok_or_else(|| fail("Missing adopted window"))?;
    validate_source_directories(&owner, root, from)?;
    let temporary = tempfile::Builder::new()
        .prefix(".oarlock-restore-preparing-")
        .tempdir_in(root)?;
    let folder = open_directory(&owner, root, temporary.path())?.into_std_file();
    AccessControl::privatize_directory(&folder)?;
    let journal = temporary.path();
    let chat_path = root.join(CHAT_STORE);
    let old_chat = read_json_at(&owner, root, &chat_path)?;
    let mut chat = old_chat.clone().unwrap_or_else(|| serde_json::json!({}));
    let map = chat
        .as_object_mut()
        .ok_or_else(|| fail("Chat store is not an object"))?;
    let active = map.remove(&active_chat_key(from));
    map.remove(&active_chat_key(MAIN));
    if let Some(active) = active {
        map.insert(active_chat_key(MAIN), active);
    }
    write_new(
        &owner,
        root,
        &journal.join("chat"),
        &serde_json::to_vec(&chat)?,
        old_chat.as_ref().map(|_| chat_path.as_path()),
    )?;
    let registry_path = root.join(REGISTRY_FILE);
    let old_registry = read_json_at(&owner, root, &registry_path)?;
    write_new(
        &owner,
        root,
        &journal.join("registry"),
        &serde_json::to_vec(&RegistryFile {
            windows: plan.open.clone(),
        })?,
        old_registry.as_ref().map(|_| registry_path.as_path()),
    )?;
    let items = paths(root, journal, from)
        .iter()
        .map(|(source, destination)| {
            Ok(Item {
                source: fingerprint(&owner, root, source)?,
                previous: fingerprint(&owner, root, destination)?,
            })
        })
        .collect::<io::Result<Vec<_>>>()?;
    let manifest = Manifest {
        version: 1,
        from: from.clone(),
        items,
    };
    write_new(
        &owner,
        root,
        &journal.join("manifest.json"),
        &serde_json::to_vec(&manifest)?,
        None,
    )?;
    sync_dir(&owner, root, journal)?;
    let (from_parent, from_name) = open_parent(&owner, root, journal)?;
    from_parent.rename(&from_name, &owner, JOURNAL)?;
    owner.into_std_file().sync_all()
}
fn move_durable(
    owner: &Dir,
    root: &Path,
    from: &Path,
    to: &Path,
    checkpoint: &mut impl FnMut() -> io::Result<()>,
) -> io::Result<()> {
    let (from_parent, from_name) = open_parent(owner, root, from)?;
    let (to_parent, to_name) = open_parent(owner, root, to)?;
    from_parent.rename(&from_name, &to_parent, &to_name)?;
    for parent in [from.parent(), to.parent()] {
        let parent = parent.ok_or_else(|| fail("Missing state parent"))?;
        sync_dir(owner, root, parent)?;
    }
    checkpoint()
}
fn recover(root: &Path, checkpoint: &mut impl FnMut() -> io::Result<()>) -> io::Result<()> {
    let owner = pin_root(root)?;
    let journal = root.join(JOURNAL);
    match owner.symlink_metadata(JOURNAL) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
        Ok(meta) if meta.is_dir() => (),
        Ok(_) => return Err(fail("Window recovery journal is not a directory")),
    }
    let manifest: Manifest = serde_json::from_value(
        read_json_at(&owner, root, &journal.join("manifest.json"))?
            .ok_or_else(|| fail("Window recovery manifest is missing"))?,
    )?;
    if manifest.version != 1
        || !is_app_window(&manifest.from)
        || manifest.from == MAIN
        || manifest.items.len() != 4
    {
        return Err(fail("Invalid window recovery manifest"));
    }
    let marker = journal.join("committed");
    let committed = match open_file(&owner, root, &marker) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(11).read_to_end(&mut bytes)?;
            if bytes != b"committed\n" {
                return Err(fail("Invalid window recovery commit marker"));
            }
            true
        }
    };
    if !committed {
        validate_source_directories(&owner, root, &manifest.from)?;
        for (index, ((source, destination), item)) in paths(root, &journal, &manifest.from)
            .iter()
            .zip(&manifest.items)
            .enumerate()
        {
            let backup = journal.join(format!("previous-{index}"));
            let old = fingerprint(&owner, root, &backup)?;
            if old != item.previous {
                // A missing backup means the old destination has not moved yet.
                if old.is_some()
                    || fingerprint(&owner, root, destination)? != item.previous
                    || fingerprint(&owner, root, source)? != item.source
                {
                    return Err(fail(format!(
                        "Window state changed during recovery: {}",
                        destination.display()
                    )));
                }
                move_durable(&owner, root, destination, &backup, checkpoint)?;
            }
            match (
                fingerprint(&owner, root, source)?,
                fingerprint(&owner, root, destination)?,
            ) {
                (Some(current), None) if Some(current.as_str()) == item.source.as_deref() => {
                    move_durable(&owner, root, source, destination, checkpoint)?
                }
                (None, current) if current == item.source => (),
                _ => {
                    return Err(fail(format!(
                        "Cannot safely resume window state publication: {}",
                        destination.display()
                    )))
                }
            }
        }
        // Recheck the complete transaction before publishing its commit marker.
        for ((source, destination), item) in paths(root, &journal, &manifest.from)
            .iter()
            .zip(&manifest.items)
        {
            if fingerprint(&owner, root, source)?.is_some()
                || fingerprint(&owner, root, destination)? != item.source
            {
                return Err(fail("Window state changed before recovery committed"));
            }
        }
        // A crash can leave an incomplete pre-commit marker. It contains no
        // user state and is rebuilt only after validating every published item.
        let (marker_parent, marker_name) =
            open_parent(&owner, root, &journal.join("commit-ready"))?;
        match marker_parent.remove_file(&marker_name) {
            Ok(()) => (),
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
        write_new(
            &owner,
            root,
            &journal.join("commit-ready"),
            b"committed\n",
            None,
        )?;
        move_durable(
            &owner,
            root,
            &journal.join("commit-ready"),
            &journal.join("committed"),
            checkpoint,
        )?;
    }
    // Retire atomically before recursive deletion: interruption during cleanup
    // cannot leave a half-deleted live journal that replays over newer app state.
    let retired = tempfile::Builder::new()
        .prefix(".oarlock-restore-retired-")
        .tempdir_in(root)?;
    let (retired_parent, retired_name) = open_parent(&owner, root, retired.path())?;
    owner.rename(JOURNAL, &retired_parent, &retired_name)?;
    owner.try_clone()?.into_std_file().sync_all()?;
    // A failed cleanup keeps backups in a private retired directory, harmless to
    // subsequent launches. It must not prevent opening fully committed state.
    if let Err(error) = retired.close() {
        log::warn!("Window recovery backup cleanup failed: {error}");
    }
    Ok(())
}

pub(super) fn run(root: &Path) -> io::Result<RestorePlan> {
    fs::create_dir_all(root)?;
    let owner = pin_root(root)?;
    let result: io::Result<RestorePlan> = (|| {
        recover(root, &mut || Ok(()))?;
        let plan = restore_plan(read_registry_at(&owner, root, &root.join(REGISTRY_FILE))?);
        if plan.adopt.is_some() {
            prepare(root, &plan)?;
            recover(root, &mut || Ok(()))?;
        }
        // An ordinary launch is read-only. In particular, do not immediately
        // replace a recovered registry and discard its preserved metadata.
        Ok(plan)
    })();
    result.map_err(|error| fail(format!("Window restoration stopped to preserve saved state: {error}. Recovery location: {}. Correct the filesystem error and relaunch; do not delete the recovery data.", root.join(JOURNAL).display())))
}

#[cfg(test)]
mod tests;
