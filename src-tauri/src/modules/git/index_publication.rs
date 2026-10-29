//! Single-index publication primitive. Objects must be verified and durable
//! BEFORE calling this; this is not the complete Stage/Commit coordinator.
//! `index.lock` is the durable prepared index; rename is the single commit point.
//! A crash before rename leaves recovery evidence, never an auto-replayed action.
use super::{
    candidate_index::{Baseline, PlannedIndex, MAX_INDEX_BYTES},
    errors::{GitError, Result},
    ownership::RepositoryPin,
    utils::owned_repo_root,
};
use crate::modules::{
    fs::{
        access_control::AccessControl,
        document_save,
        private_staging::{PrivateCandidate, CONTENT},
    },
    workspace::{WorkspaceEnv, WorkspaceRegistry},
};
use cap_std::fs::{Dir, OpenOptions};
use std::{
    fs::File,
    io::{Read, Write},
    sync::Arc,
    time::SystemTime,
};

#[cfg(test)]
thread_local! {
    static BEFORE_INDEX_RENAME: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

pub struct IndexSnapshot {
    owner: Arc<RepositoryPin>,
    directory: Dir,
    bytes: Option<Vec<u8>>,
    version: Option<String>,
    modified: Option<SystemTime>,
    stamp: Option<document_save::ChangeStamp>,
    access: Option<AccessControl>,
}
struct Current {
    bytes: Vec<u8>,
    version: String,
    modified: SystemTime,
    stamp: document_save::ChangeStamp,
    access: AccessControl,
}
fn read_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options
}
fn current(directory: &Dir, name: &str) -> Result<Option<Current>> {
    let metadata = match directory.symlink_metadata(name) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.len() > MAX_INDEX_BYTES as u64 {
        return Err(rejected("Index is not a supported regular file"));
    }
    let options = read_options();
    let file = directory.open_with(name, &options)?.into_std();
    if !file.metadata()?.is_file() {
        return Err(rejected("Index entry changed"));
    }
    let before = document_save::version(&file, &[])?;
    let before_stamp = document_save::change_stamp(&file)?;
    let metadata = file.metadata()?;
    let modified = metadata.modified()?;
    let access = AccessControl::capture(&file)?;
    let mut bytes = Vec::new();
    (&file)
        .take(MAX_INDEX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_INDEX_BYTES {
        return Err(rejected("Index exceeds the staging limit"));
    }
    let version = document_save::version(&file, &bytes)?;
    let after = document_save::version(&file, &[])?;
    if before != after || before_stamp != document_save::change_stamp(&file)? {
        return Err(rejected("Index changed while being captured"));
    }
    Ok(Some(Current {
        bytes,
        version,
        modified,
        stamp: before_stamp,
        access,
    }))
}
fn rejected(detail: &'static str) -> GitError {
    GitError::command("isolated index publication", detail)
}

#[derive(Debug)]
pub struct CommittedIndex {
    /// False means rename committed, but the directory flush failed. Never
    /// describe that as an uncommitted failure or automatically retry it.
    pub durable: bool,
    /// False means the held repository moved during commit; no replacement
    /// directory was written. The UI must refresh its repository context.
    pub repository_still_current: bool,
}

impl IndexSnapshot {
    pub fn capture(
        registry: &WorkspaceRegistry,
        root: &str,
        workspace: &WorkspaceEnv,
    ) -> Result<Self> {
        let repo = owned_repo_root(registry, root, workspace)?;
        let owner = repo
            .ownership
            .ok_or_else(|| rejected("Missing repository ownership"))?;
        let directory = owner.index_directory()?;
        let baseline = current(&directory, "index")?;
        owner.validate()?;
        let (bytes, version, modified, stamp, access) = match baseline {
            Some(before) => (
                Some(before.bytes),
                Some(before.version),
                Some(before.modified),
                Some(before.stamp),
                Some(before.access),
            ),
            None => (None, None, None, None, None),
        };
        Ok(Self {
            owner,
            directory,
            bytes,
            version,
            modified,
            stamp,
            access,
        })
    }
    pub fn bytes(&self) -> Option<&[u8]> {
        self.bytes.as_deref()
    }
    pub fn baseline(&self) -> Option<Baseline<'_>> {
        self.bytes
            .as_deref()
            .zip(self.modified)
            .map(|(bytes, modified)| Baseline { bytes, modified })
    }
    fn recheck(&self) -> Result<()> {
        self.owner.validate()?;
        let unchanged = match current(&self.directory, "index")? {
            None => self.version.is_none(),
            Some(now) => {
                Some(&now.version) == self.version.as_ref()
                    && Some(now.modified) == self.modified
                    && Some(&now.stamp) == self.stamp.as_ref()
                    && Some(&now.access) == self.access.as_ref()
            }
        };
        if !unchanged {
            return Err(rejected("Index changed; refresh before retrying"));
        }
        self.owner.validate()
    }
    pub fn publish(self, planned: &PlannedIndex) -> Result<CommittedIndex> {
        self.publish_with(planned, || {})
    }
    fn publish_with(
        self,
        planned: &PlannedIndex,
        before_commit: impl FnOnce(),
    ) -> Result<CommittedIndex> {
        self.publish_with_io(planned, before_commit, File::sync_all, |_| {})
    }
    fn publish_with_io(
        self,
        planned: &PlannedIndex,
        before_commit: impl FnOnce(),
        flush_directory: impl Fn(&File) -> std::io::Result<()>,
        reservation_created: impl FnOnce(&File),
    ) -> Result<CommittedIndex> {
        if !planned.matches_baseline(self.baseline()) {
            return Err(rejected("Index plan belongs to a different baseline"));
        }
        self.recheck()?;
        // Test support before changing the index, so filesystems that cannot
        // flush the retained directory do not silently weaken durability.
        let flush = self.directory.try_clone()?.into_std_file();
        flush_directory(&flush)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = self.directory.open_with("index.lock", &options)?.into_std();
        let mut lock = IndexLock {
            directory: &self.directory,
            file,
            owned: true,
        };
        reservation_created(&lock.file);
        let inherited = AccessControl::prepare_staging(&lock.file)?;
        // The public reservation stays empty. Readers that opened it before
        // ACL restriction never receive candidate contents through that handle.
        let candidate = PrivateCandidate::create(&self.directory)?;
        candidate.file().write_all(planned.bytes())?;
        let access = self.access.as_ref().unwrap_or(&inherited);
        access.apply(candidate.file())?;
        candidate.file().sync_all()?;
        self.recheck()?;
        candidate.verify()?;
        if !crate::modules::fs::file_identity::entry_matches(
            &self.directory,
            std::path::Path::new("index.lock"),
            &lock.file,
        )? {
            return Err(rejected("Index lock changed during preparation"));
        }
        let prepared = candidate.file().try_clone()?;
        candidate
            .directory()
            .rename(CONTENT, &self.directory, "index.lock")?;
        lock.file = prepared;
        // Persist the prepared lock entry as well as its contents before the
        // commit point, so a power loss cannot erase the recovery evidence.
        flush_directory(&flush)?;
        before_commit();
        self.recheck()?;
        // Refuse a stolen/replaced lock, even if its bytes happen to match.
        let actual = current(&self.directory, "index.lock")?
            .ok_or_else(|| rejected("Index lock disappeared"))?;
        if actual.version != document_save::version(&lock.file, planned.bytes())?
            || actual.bytes != planned.bytes()
        {
            return Err(rejected("Index lock changed before publication"));
        }
        access.verify(&lock.file)?;
        #[cfg(test)]
        BEFORE_INDEX_RENAME.with(|hook| {
            if let Some(run) = hook.borrow_mut().take() {
                run();
            }
        });
        self.directory
            .rename("index.lock", &self.directory, "index")?;
        lock.owned = false;
        // All subsequent failures are committed outcomes; never roll back over
        // newer external edits. Tools ignoring Git locks remain outside a
        // filesystem-wide transaction (final recheck cannot provide that).
        Ok(CommittedIndex {
            durable: flush_directory(&flush).is_ok(),
            repository_still_current: self.owner.validate().is_ok(),
        })
    }
}
struct IndexLock<'a> {
    directory: &'a Dir,
    file: File,
    owned: bool,
}
impl Drop for IndexLock<'_> {
    fn drop(&mut self) {
        if !self.owned {
            return;
        }
        // Only remove the lock we created, through the retained directory.
        let same = match crate::modules::fs::file_identity::entry_matches(
            self.directory,
            std::path::Path::new("index.lock"),
            &self.file,
        ) {
            Ok(same) => same,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => {
                log::warn!("Could not verify index lock ownership for cleanup: {error}");
                false
            }
        };
        if same {
            if let Err(error) = self.directory.remove_file("index.lock") {
                log::warn!("Could not release isolated Git index lock: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::git::candidate_index::{self, EntryValue};
    use std::{
        collections::BTreeMap,
        path::{Path, PathBuf},
        process::Command,
    };
    #[test]
    fn early_index_lock_readers_never_receive_prepared_index_bytes() {
        let (_temp, repo, _registry, snapshot, planned) = fixture();
        let reader = std::cell::RefCell::new(None::<File>);
        snapshot
            .publish_with_io(
                &planned,
                || {
                    let mut seen = Vec::new();
                    reader
                        .borrow_mut()
                        .as_mut()
                        .unwrap()
                        .read_to_end(&mut seen)
                        .unwrap();
                    assert!(seen.is_empty());
                },
                File::sync_all,
                |file| {
                    *reader.borrow_mut() = Some(file.try_clone().unwrap());
                },
            )
            .unwrap();
        let mut seen = Vec::new();
        reader
            .borrow_mut()
            .as_mut()
            .unwrap()
            .read_to_end(&mut seen)
            .unwrap();
        assert!(seen.is_empty());
        assert_eq!(
            std::fs::read(repo.join(".git/index")).unwrap(),
            planned.bytes()
        );
        assert!(!std::fs::read_dir(repo.join(".git"))
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".oarlock-stage-")));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn lock_cleanup_does_not_require_reading_its_contents() {
        use crate::modules::fs::access_control::tests::add_acl;
        let root = tempfile::tempdir().unwrap();
        let directory = Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        let file = directory
            .open_with(
                "index.lock",
                OpenOptions::new().write(true).create_new(true),
            )
            .unwrap()
            .into_std();
        let path = root.path().join("index.lock");
        add_acl(&path, "group:everyone deny read");
        assert!(
            File::open(&path).is_err(),
            "control: ACL must deny new content reads"
        );
        drop(IndexLock {
            directory: &directory,
            file,
            owned: true,
        });
        assert!(
            !path.exists(),
            "cleanup stranded a read-protected index lock"
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn index_replacement_preserves_acl_and_rejects_concurrent_acl_edits() {
        use crate::modules::fs::access_control::tests::{acl_text, add_acl};
        for race in [false, true] {
            let (_temp, repo, registry, snapshot, planned) = fixture();
            drop(snapshot);
            let path = repo.join(".git/index");
            add_acl(&path, "group:everyone deny execute");
            let original = std::fs::read(&path).unwrap();
            let rules = acl_text(&path);
            let snapshot =
                IndexSnapshot::capture(&registry, repo.to_str().unwrap(), &WorkspaceEnv::Local)
                    .unwrap();
            let result = snapshot.publish_with(&planned, || {
                if race {
                    add_acl(&path, "group:everyone deny write");
                }
            });
            if race {
                assert!(result.is_err());
                assert!(acl_text(&path).contains("deny write"));
                assert_eq!(std::fs::read(&path).unwrap(), original);
            } else {
                result.unwrap();
                assert_eq!(acl_text(&path), rules);
                assert_eq!(std::fs::read(&path).unwrap(), planned.bytes());
            }
            assert!(!repo.join(".git/index.lock").exists());
        }
    }
    fn git(path: &Path, args: &[&str]) -> Vec<u8> {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }
    fn fixture() -> (
        tempfile::TempDir,
        PathBuf,
        WorkspaceRegistry,
        IndexSnapshot,
        PlannedIndex,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let repo = root.join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        std::fs::write(repo.join("a"), "initial").unwrap();
        std::fs::write(repo.join("b"), "untouched").unwrap();
        git(&repo, &["-c", "index.version=2", "add", "a", "b"]);
        let registry = WorkspaceRegistry::default();
        registry.authorize(&repo).unwrap();
        let baseline = std::fs::read(repo.join(".git/index")).unwrap();
        std::fs::write(repo.join("a"), "new text").unwrap();
        git(&repo, &["add", "a"]);
        let candidate = std::fs::read(repo.join(".git/index")).unwrap();
        let oid = git(&repo, &["rev-parse", ":a"]);
        let oid = std::str::from_utf8(&oid).unwrap().trim();
        let mut digest = [0; 20];
        for (i, b) in digest.iter_mut().enumerate() {
            *b = u8::from_str_radix(&oid[i * 2..i * 2 + 2], 16).unwrap();
        }
        // Restore baseline content; Git created a new index inode when
        // staging, so recapture before preparing the publication under test.
        std::fs::write(repo.join(".git/index"), &baseline).unwrap();
        let snapshot =
            IndexSnapshot::capture(&registry, repo.to_str().unwrap(), &WorkspaceEnv::Local)
                .unwrap();
        let expected = BTreeMap::from([(
            b"a".to_vec(),
            Some(EntryValue {
                mode: 0o100644,
                oid: digest,
            }),
        )]);
        let planned = candidate_index::plan(snapshot.baseline(), &candidate, &expected).unwrap();
        (temp, repo, registry, snapshot, planned)
    }
    #[test]
    fn a_real_git_index_is_published_with_git_locking_and_only_selected_changes() {
        let (_temp, repo, _registry, snapshot, planned) = fixture();
        let outcome = snapshot.publish(&planned).unwrap();
        assert!(outcome.durable);
        assert!(outcome.repository_still_current);
        assert_eq!(git(&repo, &["show", ":a"]), b"new text");
        assert_eq!(git(&repo, &["show", ":b"]), b"untouched");
        assert!(!repo.join(".git/index.lock").exists());
    }
    #[test]
    fn publication_follows_the_owned_repository_if_it_moves_at_commit() {
        let (_temp, repo, _registry, snapshot, planned) = fixture();
        let moved = repo.with_file_name("moved-repository");
        let from = repo.clone();
        let to = moved.clone();
        let replacement_repo = repo.clone();
        BEFORE_INDEX_RENAME.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                std::fs::rename(from, to).unwrap();
                // A replacement at the displayed path is not the owner.
                std::fs::create_dir(&repo).unwrap();
                std::fs::create_dir(repo.join(".git")).unwrap();
                std::fs::write(repo.join(".git/index"), b"replacement index").unwrap();
            }));
        });
        let result = snapshot.publish(&planned).unwrap();
        assert!(!result.repository_still_current);
        assert_eq!(
            std::fs::read(moved.join(".git/index")).unwrap(),
            planned.bytes()
        );
        assert_eq!(
            std::fs::read(replacement_repo.join(".git/index")).unwrap(),
            b"replacement index"
        );
    }
    #[test]
    fn publication_keeps_unselected_racy_edits_visible_to_real_git() {
        use std::fs::FileTimes;
        let (_temp, repo, registry, snapshot, _planned) = fixture();
        drop(snapshot);
        // Whole-second stat comparison is supported by Git and models a
        // coarse-timestamp filesystem without a timing-dependent test.
        git(&repo, &["config", "core.trustctime", "false"]);
        git(&repo, &["config", "core.checkstat", "minimal"]);
        let path = repo.join("b");
        let time = SystemTime::now() - std::time::Duration::from_secs(10);
        let file = File::options().write(true).open(&path).unwrap();
        file.set_times(FileTimes::new().set_modified(time)).unwrap();
        git(&repo, &["add", "b"]);
        let time = file.metadata().unwrap().modified().unwrap();
        std::fs::write(&path, "new edits").unwrap(); // same length as "untouched"
        file.set_times(FileTimes::new().set_modified(time)).unwrap();
        File::options()
            .write(true)
            .open(repo.join(".git/index"))
            .unwrap()
            .set_times(FileTimes::new().set_modified(time))
            .unwrap();
        let snapshot =
            IndexSnapshot::capture(&registry, repo.to_str().unwrap(), &WorkspaceEnv::Local)
                .unwrap();
        assert_eq!(git(&repo, &["diff", "--name-only", "--", "b"]), b"b\n");
        let planned = candidate_index::plan(
            snapshot.baseline(),
            snapshot.bytes().unwrap(),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(snapshot.publish(&planned).unwrap().durable);
        assert_eq!(
            git(&repo, &["diff", "--name-only", "--", "b"]),
            b"b\n",
            "publication hid an unselected edit by advancing the index timestamp"
        );
        assert_eq!(git(&repo, &["show", ":b"]), b"untouched");
        assert_eq!(std::fs::read(path).unwrap(), b"new edits");
    }
    #[test]
    fn changing_only_the_index_timestamp_invalidates_a_plan() {
        let (_temp, repo, _registry, snapshot, planned) = fixture();
        let before = snapshot.bytes().unwrap().to_vec();
        File::options()
            .write(true)
            .open(repo.join(".git/index"))
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH))
            .unwrap();
        assert!(snapshot.publish(&planned).is_err());
        assert_eq!(std::fs::read(repo.join(".git/index")).unwrap(), before);
        assert!(!repo.join(".git/index.lock").exists());
    }
    #[cfg(unix)]
    #[test]
    fn a_permission_tightening_is_not_reverted_by_publication() {
        use std::os::unix::fs::PermissionsExt;
        let (_temp, repo, registry, snapshot, planned) = fixture();
        drop(snapshot);
        let path = repo.join(".git/index");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let snapshot =
            IndexSnapshot::capture(&registry, repo.to_str().unwrap(), &WorkspaceEnv::Local)
                .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            snapshot.publish(&planned).is_err(),
            "a stale save must not undo chmod"
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    #[test]
    fn another_git_writer_keeps_its_lock_and_new_index() {
        let (_temp, repo, _registry, snapshot, planned) = fixture();
        let old = std::fs::read(repo.join(".git/index")).unwrap();
        std::fs::write(repo.join(".git/index.lock"), "other writer").unwrap();
        assert!(snapshot.publish(&planned).is_err());
        assert_eq!(std::fs::read(repo.join(".git/index")).unwrap(), old);
        assert_eq!(
            std::fs::read(repo.join(".git/index.lock")).unwrap(),
            b"other writer"
        );
    }
    #[test]
    fn an_identical_replacement_is_still_a_conflict() {
        let (_temp, repo, _registry, snapshot, planned) = fixture();
        let bytes = std::fs::read(repo.join(".git/index")).unwrap();
        std::fs::rename(repo.join(".git/index"), repo.join(".git/index.old")).unwrap();
        std::fs::write(repo.join(".git/index"), &bytes).unwrap();
        assert!(snapshot.publish(&planned).is_err());
        assert_eq!(std::fs::read(repo.join(".git/index")).unwrap(), bytes);
    }
    #[test]
    fn a_new_edit_after_staging_is_not_rolled_back() {
        let (_temp, repo, _registry, snapshot, planned) = fixture();
        let result = snapshot.publish_with(&planned, || {
            std::fs::write(repo.join(".git/index"), "new external index").unwrap();
        });
        assert!(result.is_err());
        assert_eq!(
            std::fs::read(repo.join(".git/index")).unwrap(),
            b"new external index"
        );
        assert!(!repo.join(".git/index.lock").exists());
    }
    #[cfg(unix)]
    #[test]
    fn metadata_replacement_never_redirects_publication_or_cleanup() {
        let (_temp, repo, _registry, snapshot, planned) = fixture();
        let other = repo.with_file_name("other");
        std::fs::create_dir(&other).unwrap();
        std::fs::write(other.join("index"), "other index").unwrap();
        std::fs::write(other.join("index.lock"), "other lock").unwrap();
        let old = std::fs::read(repo.join(".git/index")).unwrap();
        let result = snapshot.publish_with(&planned, || {
            std::fs::rename(repo.join(".git"), repo.join("held-git")).unwrap();
            std::os::unix::fs::symlink(&other, repo.join(".git")).unwrap();
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(other.join("index")).unwrap(), b"other index");
        assert_eq!(
            std::fs::read(other.join("index.lock")).unwrap(),
            b"other lock"
        );
        assert_eq!(std::fs::read(repo.join("held-git/index")).unwrap(), old);
        assert!(!repo.join("held-git/index.lock").exists());
    }
    #[test]
    fn a_replaced_lock_is_not_published_or_removed() {
        let (_temp, repo, _registry, snapshot, planned) = fixture();
        let old = std::fs::read(repo.join(".git/index")).unwrap();
        let result = snapshot.publish_with(&planned, || {
            std::fs::rename(repo.join(".git/index.lock"), repo.join(".git/held-lock")).unwrap();
            std::fs::write(repo.join(".git/index.lock"), planned.bytes()).unwrap();
        });
        assert!(result.is_err());
        assert!(repo.join(".git/index.lock").exists());
        assert_eq!(std::fs::read(repo.join(".git/index")).unwrap(), old);
    }
    #[test]
    fn a_directory_flush_failure_reports_committed_and_never_rolls_back() {
        let (_temp, repo, _registry, snapshot, planned) = fixture();
        let calls = std::cell::Cell::new(0);
        let result = snapshot
            .publish_with_io(
                &planned,
                || {},
                |file| {
                    calls.set(calls.get() + 1);
                    if calls.get() == 3 {
                        Err(std::io::Error::other("injected directory flush failure"))
                    } else {
                        file.sync_all()
                    }
                },
                |_| {},
            )
            .unwrap();
        assert!(!result.durable);
        assert!(result.repository_still_current);
        assert_eq!(
            std::fs::read(repo.join(".git/index")).unwrap(),
            planned.bytes()
        );
        assert!(!repo.join(".git/index.lock").exists());
    }
    #[cfg(unix)]
    #[test]
    fn a_substituted_fifo_lock_cannot_hang_cleanup() {
        use std::os::unix::ffi::OsStrExt;
        let (_temp, repo, _registry, snapshot, planned) = fixture();
        let result = snapshot.publish_with(&planned, || {
            let path = repo.join(".git/index.lock");
            std::fs::rename(&path, repo.join(".git/held-lock")).unwrap();
            let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        });
        assert!(result.is_err());
        use std::os::unix::fs::FileTypeExt;
        assert!(std::fs::symlink_metadata(repo.join(".git/index.lock"))
            .unwrap()
            .file_type()
            .is_fifo());
    }
    #[test]
    fn a_crash_before_rename_keeps_the_old_index_and_prepared_lock() {
        const CHILD: &str = "OARLOCK_INDEX_CRASH_FIXTURE";
        if let Some(path) = std::env::var_os(CHILD) {
            use sha1::{Digest, Sha1};
            let repo = PathBuf::from(path);
            let registry = WorkspaceRegistry::default();
            registry.authorize(&repo).unwrap();
            let snapshot =
                IndexSnapshot::capture(&registry, repo.to_str().unwrap(), &WorkspaceEnv::Local)
                    .unwrap();
            let candidate = std::fs::read(repo.with_file_name("candidate-index")).unwrap();
            let expected = BTreeMap::from([(
                b"a".to_vec(),
                Some(EntryValue {
                    mode: 0o100644,
                    oid: Sha1::digest(b"blob 8\0new text").into(),
                }),
            )]);
            let planned =
                candidate_index::plan(snapshot.baseline(), &candidate, &expected).unwrap();
            let _ = snapshot.publish_with(&planned, || std::process::exit(73));
            panic!("crash injection not reached");
        }
        let (_temp, repo, registry, snapshot, planned) = fixture();
        let old = snapshot.bytes().unwrap().to_vec();
        drop(snapshot);
        std::fs::write(repo.with_file_name("candidate-index"), planned.bytes()).unwrap();
        let output=Command::new(std::env::current_exe().unwrap())
            .args(["--exact","modules::git::index_publication::tests::a_crash_before_rename_keeps_the_old_index_and_prepared_lock","--nocapture"])
            .env(CHILD,&repo).output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(73),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(std::fs::read(repo.join(".git/index")).unwrap(), old);
        assert_eq!(
            std::fs::read(repo.join(".git/index.lock")).unwrap(),
            planned.bytes()
        );
        let retry = IndexSnapshot::capture(&registry, repo.to_str().unwrap(), &WorkspaceEnv::Local)
            .unwrap();
        assert!(retry.publish(&planned).is_err());
        assert_eq!(std::fs::read(repo.join(".git/index")).unwrap(), old);
    }
    #[test]
    fn a_forged_candidate_tree_cache_cannot_change_the_next_commit_tree() {
        use sha1::{Digest, Sha1};
        let (_temp, repo, registry, snapshot, planned) = fixture();
        drop(snapshot);
        let old_tree = git(&repo, &["write-tree"]);
        let old_tree = std::str::from_utf8(&old_tree).unwrap().trim();
        let snapshot =
            IndexSnapshot::capture(&registry, repo.to_str().unwrap(), &WorkspaceEnv::Local)
                .unwrap();
        let mut oid = [0u8; 20];
        for (i, b) in oid.iter_mut().enumerate() {
            *b = u8::from_str_radix(&old_tree[2 * i..2 * i + 2], 16).unwrap();
        }
        let mut forged = planned.bytes()[..planned.bytes().len() - 20].to_vec();
        let mut cache = b"\0".to_vec();
        cache.extend_from_slice(b"2 0\n");
        cache.extend_from_slice(&oid);
        forged.extend_from_slice(b"TREE");
        forged.extend_from_slice(&(cache.len() as u32).to_be_bytes());
        forged.extend_from_slice(&cache);
        let checksum = Sha1::digest(&forged);
        forged.extend_from_slice(&checksum);
        let path = repo.with_file_name("forged-index");
        std::fs::write(&path, &forged).unwrap();
        let control = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .arg("write-tree")
            .env("GIT_INDEX_FILE", &path)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .output()
            .unwrap();
        assert!(control.status.success());
        assert_eq!(
            String::from_utf8_lossy(&control.stdout).trim(),
            old_tree,
            "Git did not use the forged cache"
        );
        let expected = BTreeMap::from([(
            b"a".to_vec(),
            Some(EntryValue {
                mode: 0o100644,
                oid: Sha1::digest(b"blob 8\0new text").into(),
            }),
        )]);
        let safe = candidate_index::plan(snapshot.baseline(), &forged, &expected).unwrap();
        snapshot.publish(&safe).unwrap();
        let tree = git(&repo, &["write-tree"]);
        let tree = String::from_utf8_lossy(&tree);
        let tree = tree.trim();
        assert_ne!(tree, old_tree);
        assert_eq!(git(&repo, &["show", &format!("{tree}:a")]), b"new text");
        assert_eq!(git(&repo, &["show", &format!("{tree}:b")]), b"untouched");
    }
}
