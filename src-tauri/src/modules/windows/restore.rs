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

// Hash incrementally: adoption does not load scrollback into memory. Names are
// length-framed and sorted; links/special files are refused, never traversed.
fn fingerprint(path: &Path) -> io::Result<Option<String>> {
    fn visit(path: &Path, hash: &mut Sha256, depth: usize) -> io::Result<()> {
        if depth > 128 {
            return Err(fail("Window state directory nesting is excessive"));
        }
        let meta = fs::symlink_metadata(path)?;
        if meta.is_file() {
            hash.update(b"file");
            hash.update(meta.len().to_le_bytes());
            let mut file = crate::modules::fs::open_store_file(path)?;
            let mut bytes = [0; 64 * 1024];
            loop {
                let n = file.read(&mut bytes)?;
                if n == 0 {
                    break;
                }
                hash.update(&bytes[..n]);
            }
        } else if meta.is_dir() {
            hash.update(b"directory");
            let mut entries = fs::read_dir(path)?.collect::<io::Result<Vec<_>>>()?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                let name = entry.file_name();
                let bytes = name.as_encoded_bytes();
                hash.update((bytes.len() as u64).to_le_bytes());
                hash.update(bytes);
                visit(&entry.path(), hash, depth + 1)?;
            }
            hash.update(b"end");
        } else {
            return Err(fail(format!(
                "Unsupported window state entry: {}",
                path.display()
            )));
        }
        Ok(())
    }
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
        Ok(_) => (),
    }
    let mut hash = Sha256::new();
    visit(path, &mut hash, 0)?;
    Ok(Some(format!("{:x}", hash.finalize())))
}
fn sync_dir(path: &Path) -> io::Result<()> {
    cap_std::fs::Dir::open_ambient_dir(path, cap_std::ambient_authority())?
        .into_std_file()
        .sync_all()
}
fn write_new(path: &Path, bytes: &[u8], previous: Option<&Path>) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).read(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    if let Some(previous) = previous {
        // Candidate is already inside a private directory. Preserve the exact
        // original access rules and supported metadata before publication.
        AccessControl::capture(&File::open(previous)?)?.apply(&file)?;
    }
    file.sync_all()
}
fn read_json(path: &Path) -> io::Result<Option<serde_json::Value>> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
        Ok(meta) if meta.is_file() => {
            let mut file = crate::modules::fs::open_store_file(path)?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            Ok(Some(serde_json::from_slice(&bytes)?))
        },
        Ok(_) => Err(fail(format!(
            "Expected a regular state file: {}",
            path.display()
        ))),
    }
}
pub(super) fn read_registry(path: &Path) -> io::Result<Vec<String>> {
    match read_json(path)? {
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
fn validate_source_directories(root: &Path, from: &str) -> io::Result<()> {
    for directory in [root.join(super::WINDOWS_DIRECTORY), data_root(root, from)] {
        match fs::symlink_metadata(&directory) {
            Ok(meta) if meta.is_dir() => (),
            Err(e) if e.kind() == io::ErrorKind::NotFound => break,
            Err(e) => return Err(e),
            Ok(_) => {
                return Err(fail(format!(
                    "Window state directory is not a plain directory: {}",
                    directory.display()
                )))
            }
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
    validate_source_directories(root, from)?;
    let temporary = tempfile::Builder::new()
        .prefix(".oarlock-restore-preparing-")
        .tempdir_in(root)?;
    let folder = File::open(temporary.path())?;
    AccessControl::privatize_directory(&folder)?;
    let journal = temporary.path();
    let chat_path = root.join(CHAT_STORE);
    let old_chat = read_json(&chat_path)?;
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
        &journal.join("chat"),
        &serde_json::to_vec(&chat)?,
        old_chat.as_ref().map(|_| chat_path.as_path()),
    )?;
    let registry_path = root.join(REGISTRY_FILE);
    let old_registry = read_json(&registry_path)?;
    write_new(
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
                source: fingerprint(source)?,
                previous: fingerprint(destination)?,
            })
        })
        .collect::<io::Result<Vec<_>>>()?;
    let manifest = Manifest {
        version: 1,
        from: from.clone(),
        items,
    };
    write_new(
        &journal.join("manifest.json"),
        &serde_json::to_vec(&manifest)?,
        None,
    )?;
    sync_dir(journal)?;
    owner.rename(relative(root, journal)?, &owner, JOURNAL)?;
    owner.into_std_file().sync_all()
}
fn move_durable(
    owner: &Dir,
    root: &Path,
    from: &Path,
    to: &Path,
    checkpoint: &mut impl FnMut() -> io::Result<()>,
) -> io::Result<()> {
    owner.rename(relative(root, from)?, owner, relative(root, to)?)?;
    for parent in [from.parent(), to.parent()] {
        let parent = parent.ok_or_else(|| fail("Missing state parent"))?;
        let path = relative(root, parent)?;
        owner.open_dir(if path.as_os_str().is_empty() { Path::new(".") } else { path })?.into_std_file().sync_all()?;
    }
    checkpoint()
}
fn recover(root: &Path, checkpoint: &mut impl FnMut() -> io::Result<()>) -> io::Result<()> {
    let owner = pin_root(root)?;
    let journal = root.join(JOURNAL);
    match fs::symlink_metadata(&journal) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
        Ok(meta) if meta.is_dir() => (),
        Ok(_) => return Err(fail("Window recovery journal is not a directory")),
    }
    let manifest: Manifest = serde_json::from_value(
        read_json(&journal.join("manifest.json"))?
            .ok_or_else(|| fail("Window recovery manifest is missing"))?,
    )?;
    if manifest.version != 1
        || !is_app_window(&manifest.from)
        || manifest.from == MAIN
        || manifest.items.len() != 4
    {
        return Err(fail("Invalid window recovery manifest"));
    }
    if !journal.join("committed").try_exists()? {
        validate_source_directories(root, &manifest.from)?;
        for (index, ((source, destination), item)) in paths(root, &journal, &manifest.from)
            .iter()
            .zip(&manifest.items)
            .enumerate()
        {
            let backup = journal.join(format!("previous-{index}"));
            let old = fingerprint(&backup)?;
            if old != item.previous {
                // A missing backup means the old destination has not moved yet.
                if old.is_some()
                    || fingerprint(destination)? != item.previous
                    || fingerprint(source)? != item.source
                {
                    return Err(fail(format!(
                        "Window state changed during recovery: {}",
                        destination.display()
                    )));
                }
                move_durable(&owner, root, destination, &backup, checkpoint)?;
            }
            match (fingerprint(source)?, fingerprint(destination)?) {
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
            if fingerprint(source)?.is_some() || fingerprint(destination)? != item.source {
                return Err(fail("Window state changed before recovery committed"));
            }
        }
        // A crash can leave an incomplete pre-commit marker. It contains no
        // user state and is rebuilt only after validating every published item.
        match owner.remove_file(relative(root, &journal.join("commit-ready"))?) {
            Ok(()) => (),
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
        write_new(&journal.join("commit-ready"), b"committed\n", None)?;
        move_durable(
            &owner,
            root,
            &journal.join("commit-ready"),
            &journal.join("committed"),
            checkpoint,
        )?;
    } else if fs::read(journal.join("committed"))? != b"committed\n" {
        return Err(fail("Invalid window recovery commit marker"));
    }
    // Retire atomically before recursive deletion: interruption during cleanup
    // cannot leave a half-deleted live journal that replays over newer app state.
    let retired = tempfile::Builder::new()
        .prefix(".oarlock-restore-retired-")
        .tempdir_in(root)?;
    owner.rename(relative(root, &journal)?, &owner, relative(root, retired.path())?)?;
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
    let _owner = pin_root(root)?;
    let result: io::Result<RestorePlan> = (|| {
        recover(root, &mut || Ok(()))?;
        let plan = restore_plan(read_registry(&root.join(REGISTRY_FILE))?);
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
