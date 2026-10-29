//! Best-effort conditional updates for agent-owned settings paths.
//! External writers do not honor the native lock: the final check and rename
//! are not an atomic compare-and-swap, as documented by document_save.
use crate::modules::fs::{attachment, document_save};
use std::{fs, io::Read, path::{Path, PathBuf}};

struct Binding {
    requested: PathBuf,
    parent: PathBuf,
    target: PathBuf,
    link: Option<fs::Metadata>,
}

impl Binding {
    fn capture(path: &Path) -> Result<Self, String> {
        let parent = path.parent().ok_or("Agent settings have no parent directory")?;
        let canonical_parent = fs::canonicalize(parent)
            .map_err(|e| format!("resolve {}: {e}", parent.display()))?;
        let requested = path.to_path_buf();
        let meta = match fs::symlink_metadata(&requested) {
            Ok(meta) => Some(meta),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("inspect {}: {e}", requested.display())),
        };
        let link = meta.filter(|m| m.file_type().is_symlink());
        let target = if link.is_some() {
            fs::canonicalize(&requested).map_err(|e| format!("resolve {}: {e}", requested.display()))?
        } else { canonical_parent.join(path.file_name().ok_or("Agent settings have no file name")?) };
        Ok(Self { requested, parent: canonical_parent, target, link })
    }

    fn validate(&self, path: &Path) -> Result<(), String> {
        if path != self.target { return Err("Agent settings destination moved".into()); }
        let parent = self.requested.parent().ok_or("Agent settings have no parent directory")?;
        if fs::canonicalize(parent).map_err(|e| e.to_string())? != self.parent {
            return Err("Agent settings parent changed; retry the operation".into());
        }
        let current = fs::symlink_metadata(&self.requested);
        match (&self.link, current) {
            (Some(original), Ok(now)) => {
                if !now.file_type().is_symlink() || !same_link(original, &now)? ||
                    fs::canonicalize(&self.requested).map_err(|e| e.to_string())? != self.target {
                    return Err("Agent settings symlink changed; retry the operation".into());
                }
            }
            (Some(_), Err(_)) => return Err("Agent settings symlink disappeared; retry the operation".into()),
            (None, Ok(now)) if now.file_type().is_symlink() => return Err("Agent settings became a symlink; retry the operation".into()),
            (None, Ok(_)) => {},
            (None, Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {},
            (None, Err(e)) => return Err(e.to_string()),
        }
        Ok(())
    }
}

#[cfg(unix)]
fn same_link(a: &fs::Metadata, b: &fs::Metadata) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;
    Ok(a.dev() == b.dev() && a.ino() == b.ino() && a.ctime() == b.ctime() && a.ctime_nsec() == b.ctime_nsec())
}
#[cfg(not(unix))]
fn same_link(_: &fs::Metadata, _: &fs::Metadata) -> Result<bool, String> {
    Err("Verifying symlink identity is unsupported on this platform".into())
}

/// The transform runs while the target's Oarlock lock is held and reads a
/// snapshot whose content and identity are checked again before publication.
pub(super) fn edit(path: &Path, transform: impl FnOnce(Option<&str>) -> Result<Option<String>, String>) -> Result<(), String> {
    let initial = Binding::capture(path)?;
    document_save::with_lock(&initial.target, || {
        let binding = Binding::capture(path)?;
        if binding.target != initial.target { return Err("Agent settings destination changed; retry the operation".into()); }
        match (&initial.link, &binding.link) {
            (Some(a), Some(b)) if same_link(a, b)? => {},
            (None, None) => {},
            _ => return Err("Agent settings symlink changed; retry the operation".into()),
        }
        binding.validate(&binding.target)?;
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let snapshot = match options.open(&binding.target) {
            Ok(mut file) => {
                if !file.metadata().map_err(|e| e.to_string())?.is_file() { return Err("Agent settings are not a regular file".into()); }
                let opened = attachment::handle_path(&file)?;
                binding.validate(&opened)?;
                let before = document_save::change_stamp(&file).map_err(|e| e.to_string())?;
                let mut bytes = Vec::new();
                file.by_ref().take(50 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                if bytes.len() > 50 * 1024 * 1024 { return Err("Agent settings exceed the 50 MiB limit".into()); }
                if before != document_save::change_stamp(&file).map_err(|e| e.to_string())? { return Err("Agent settings changed while reading; retry the operation".into()); }
                let version = document_save::version(&file, &bytes).map_err(|e| e.to_string())?;
                let content = String::from_utf8(bytes).map_err(|_| "Agent settings are not valid UTF-8")?;
                Some((content, version))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && binding.link.is_none() => None,
            Err(e) => return Err(format!("read {}: {e}", binding.target.display())),
        };
        let Some(contents) = transform(snapshot.as_ref().map(|(s, _)| s.as_str()))? else { return Ok(()); };
        document_save::write_checked(&binding.target, contents.as_bytes(), snapshot.as_ref().map(|(_, v)| v.as_str()), |actual| binding.validate(actual))
            .map(|_| ())
            .map_err(|e| match e {
                document_save::SaveError::Conflict(_) => "Agent settings changed during installation; retry the operation".into(),
                document_save::SaveError::Failed(e) => format!("Cannot safely install agent hooks: {e}"),
            })
    })
}
