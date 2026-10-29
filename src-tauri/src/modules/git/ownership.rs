//! Operation-scoped directory ownership. Never changes the app process's cwd.
use super::errors::{GitError, Result};
use crate::modules::{
    fs::attachment::handle_path,
    workspace::{WorkspaceEnv, WorkspaceRegistry},
};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

/// Git's own discovery is not an ownership boundary: core.worktree, gitfiles
/// and commondir can redirect commands without replacing the selected folder.
#[derive(Debug)]
pub(crate) struct RepositoryPin {
    worktree: DirectoryPin,
    git: DirectoryPin,
    common: Option<DirectoryPin>,
    bare: bool,
    linked_authorization: bool,
}
impl RepositoryPin {
    pub fn acquire(
        worktree: DirectoryPin,
        workspace: &WorkspaceEnv,
        registry: &WorkspaceRegistry,
    ) -> Result<Self> {
        let bare = match std::fs::symlink_metadata(worktree.path().join(".git")) {
            Ok(_) => false,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
            Err(e) => return Err(e.into()),
        };
        let (git_path, common_path) = layout(worktree.path(), bare)?;
        let linked_authorization =
            authorize_metadata(registry, worktree.path(), &git_path, &common_path)?;
        let git = DirectoryPin::acquire(&git_path, workspace)?;
        let common = if common_path == git_path {
            None
        } else {
            Some(DirectoryPin::acquire(&common_path, workspace)?)
        };
        let pin = Self {
            worktree,
            git,
            common,
            bare,
            linked_authorization,
        };
        pin.validate()?;
        let output = super::process::discover_owned_git(&pin.worktree, workspace)?;
        let text = std::str::from_utf8(&output.stdout).map_err(|_| context_changed())?;
        let lines: Vec<_> = text.lines().collect();
        // --show-toplevel fails for a bare repository, after the first three
        // fields. Bare repositories remain usable for worktree management.
        if output.timed_out
            || output.truncated
            || (bare && (output.exit_code != Some(128) || lines.len() != 3))
            || (!bare && (output.exit_code != Some(0) || lines.len() != 4))
            || lines.get(2) != Some(&if bare { "true" } else { "false" })
        {
            return Err(context_changed());
        }
        let canonical = |value: &str| std::fs::canonicalize(value).map_err(GitError::Io);
        if canonical(lines[0])? != pin.git.path
            || canonical(lines[1])? != pin.common_path()
            || (!bare && canonical(lines[3])? != pin.worktree.path)
        {
            return Err(context_changed());
        }
        pin.validate()?;
        Ok(pin)
    }
    pub fn path(&self) -> &Path {
        self.worktree.path()
    }
    pub(super) fn index_directory(&self) -> Result<cap_std::fs::Dir> {
        self.validate()?;
        Ok(cap_std::fs::Dir::from_std_file(
            self.git.directory.try_clone()?,
        ))
    }

    fn common_path(&self) -> &Path {
        self.common.as_ref().unwrap_or(&self.git).path()
    }
    pub(super) fn hooks_path(&self) -> PathBuf {
        self.common_path().join("hooks")
    }
    pub(super) fn worktree_config_path(&self) -> PathBuf {
        self.git.path().join("config.worktree")
    }
    pub fn validate(&self) -> Result<()> {
        self.worktree.validate()?;
        self.git.validate()?;
        if let Some(common) = &self.common {
            common.validate()?;
        }
        let (git, common) = layout(self.path(), self.bare)?;
        if git != self.git.path || common != self.common_path() {
            return Err(context_changed());
        }
        if self.linked_authorization && !reciprocal_worktree(self.path(), &git, &common)? {
            return Err(context_changed());
        }
        Ok(())
    }
    pub fn configure(&self, command: &mut Command) -> Result<()> {
        self.validate()?;
        self.git.check_at_spawn(command, false)?;
        if let Some(common) = &self.common {
            common.check_at_spawn(command, false)?;
        }
        self.worktree.configure(command)?;
        // These are deliberate, operation-owned overrides added after inherited
        // GIT_* overrides are removed. Git must not rediscover a new context.
        command
            .env("GIT_DIR", self.git.path())
            .env("GIT_COMMON_DIR", self.common_path());
        if !self.bare {
            command.env("GIT_WORK_TREE", self.path());
        }
        Ok(())
    }
}

/// The caller has already authorized this repository's metadata. Used for
/// WSL reads, where Windows cannot retain Linux directory ownership handles.
pub(super) fn unowned_metadata_paths(root: &Path) -> Result<(PathBuf, PathBuf)> {
    let bare = match std::fs::symlink_metadata(root.join(".git")) {
        Ok(_) => false,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => return Err(e.into()),
    };
    layout(root, bare)
}

/// Check metadata trust before invoking Git, including read-only discovery.
pub(super) fn authorize_repository_metadata(
    registry: &WorkspaceRegistry,
    root: &Path,
) -> Result<()> {
    let bare = match std::fs::symlink_metadata(root.join(".git")) {
        Ok(_) => false,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => return Err(e.into()),
    };
    let (git, common) = layout(root, bare)?;
    authorize_metadata(registry, root, &git, &common).map(drop)
}

pub(super) fn authorize_containing_metadata(
    registry: &WorkspaceRegistry,
    cwd: &Path,
) -> Result<()> {
    for root in cwd.ancestors() {
        match std::fs::symlink_metadata(root.join(".git")) {
            Ok(_) => return authorize_repository_metadata(registry, root),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

fn authorize_metadata(
    registry: &WorkspaceRegistry,
    root: &Path,
    git: &Path,
    common: &Path,
) -> Result<bool> {
    let trusted = |path: &Path| path.starts_with(root) || registry.is_authorized(path);
    if trusted(git) && trusted(common) {
        return Ok(false);
    }
    if reciprocal_worktree(root, git, common)? {
        return Ok(true);
    }
    Err(GitError::PathOutsideWorkspace(
        if !trusted(git) { git } else { common }.into(),
    ))
}

fn reciprocal_worktree(root: &Path, git: &Path, common: &Path) -> Result<bool> {
    // A gitfile alone grants no access. Only Git's linked-worktree layout with
    // an exact backlink to this worktree's marker can share external metadata.
    if git == common || git.parent() != Some(common.join("worktrees").as_path()) {
        return Ok(false);
    }
    let marker = root.join(".git");
    if !std::fs::symlink_metadata(&marker)?.is_file() {
        return Ok(false);
    }
    let backlink = read_pointer(&git.join("gitdir"))?;
    Ok(std::fs::canonicalize(git.join(backlink.trim_end_matches(['\r', '\n'])))? == marker)
}

fn context_changed() -> GitError {
    GitError::command("repository ownership", "Git's worktree or metadata does not match the selected repository, or changed during the operation. Refresh the repository before retrying.")
}

/// Resolve gitfiles and linked-worktree commondir without executing Git or
/// traversing an unbounded file. Explicit execution paths bypass these pointers.
fn layout(root: &Path, bare: bool) -> Result<(PathBuf, PathBuf)> {
    let marker = root.join(".git");
    let git = if bare {
        root.to_path_buf()
    } else {
        let meta = std::fs::symlink_metadata(&marker)?;
        if meta.is_dir() {
            marker
        } else if meta.is_file() {
            let pointer = read_pointer(&marker)?;
            let target = pointer
                .strip_prefix("gitdir: ")
                .ok_or_else(context_changed)?;
            root.join(target.trim_end_matches(['\r', '\n']))
        } else {
            return Err(context_changed());
        }
    };
    let git = std::fs::canonicalize(git)?;
    let common = match std::fs::symlink_metadata(git.join("commondir")) {
        Ok(_) => git.join(read_pointer(&git.join("commondir"))?.trim_end_matches(['\r', '\n'])),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => git.clone(),
        Err(e) => return Err(e.into()),
    };
    Ok((git, std::fs::canonicalize(common)?))
}
fn read_pointer(path: &Path) -> Result<String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(context_changed());
    }
    let mut text = String::new();
    file.take(16 * 1024 + 1).read_to_string(&mut text)?;
    if text.is_empty() || text.len() > 16 * 1024 || text.contains('\0') {
        return Err(context_changed());
    }
    Ok(text)
}

#[derive(Debug)]
pub(crate) struct DirectoryPin {
    directory: Arc<File>,
    path: PathBuf,
    #[cfg(windows)]
    _ancestors: Vec<File>,
}
impl DirectoryPin {
    pub fn acquire(path: &Path, workspace: &WorkspaceEnv) -> Result<Self> {
        if workspace.is_wsl() {
            return Err(GitError::command("repository ownership", "Native Git changes in WSL require Linux-side directory ownership, which is not available yet. Run this operation in the WSL terminal."));
        }
        let path = std::fs::canonicalize(path)?;
        #[cfg(unix)]
        let directory = {
            use std::os::unix::fs::OpenOptionsExt;
            OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open(&path)?
        };
        #[cfg(windows)]
        let (directory, ancestors) = {
            use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            };
            let mut handles = Vec::new();
            for component in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
                // Deny writes to directory entries and rename/delete of every
                // ancestor while CreateProcess and Git use the absolute cwd.
                let file = OpenOptions::new()
                    .read(true)
                    .share_mode(FILE_SHARE_READ)
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(component)?;
                if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    return Err(changed());
                }
                if handle_path(&file).map_err(|e| GitError::command("repository ownership", e))?
                    != component
                {
                    return Err(changed());
                }
                handles.push(file);
            }
            let directory = handles.pop().ok_or_else(changed)?;
            (directory, handles)
        };
        let pin = Self {
            directory: Arc::new(directory),
            path,
            #[cfg(windows)]
            _ancestors: ancestors,
        };
        pin.validate()?;
        Ok(pin)
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn validate(&self) -> Result<()> {
        if !self.directory.metadata()?.is_dir()
            || handle_path(&self.directory)
                .map_err(|e| GitError::command("repository ownership", e))?
                != self.path
            || std::fs::symlink_metadata(&self.path)?
                .file_type()
                .is_symlink()
        {
            return Err(changed());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let held = self.directory.metadata()?;
            let named = std::fs::metadata(&self.path)?;
            if held.dev() != named.dev() || held.ino() != named.ino() {
                return Err(changed());
            }
        }
        Ok(())
    }
    pub fn configure(&self, command: &mut Command) -> Result<()> {
        self.check_at_spawn(command, true)
    }
    fn check_at_spawn(&self, command: &mut Command, enter: bool) -> Result<()> {
        self.validate()?;
        #[cfg(unix)]
        {
            use std::{
                ffi::CString,
                os::unix::{ffi::OsStrExt, io::AsRawFd, process::CommandExt},
            };
            let directory = self.directory.clone();
            let path = CString::new(self.path.as_os_str().as_bytes()).map_err(|_| changed())?;
            // Only async-signal-safe syscalls in the fork child. The Arc keeps
            // the descriptor alive even if the original operation is dropped.
            unsafe {
                command.pre_exec(move || {
                    let mut held = std::mem::MaybeUninit::<libc::stat>::uninit();
                    let mut named = std::mem::MaybeUninit::<libc::stat>::uninit();
                    if libc::fstat(directory.as_raw_fd(), held.as_mut_ptr()) != 0
                        || libc::lstat(path.as_ptr(), named.as_mut_ptr()) != 0
                    {
                        return Err(std::io::Error::last_os_error());
                    }
                    let held = held.assume_init();
                    let named = named.assume_init();
                    if held.st_dev != named.st_dev || held.st_ino != named.st_ino {
                        return Err(std::io::Error::from_raw_os_error(libc::ESTALE));
                    }
                    if enter && libc::fchdir(directory.as_raw_fd()) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        #[cfg(windows)]
        if enter {
            command.current_dir(&self.path);
        }
        Ok(())
    }
}
fn changed() -> GitError {
    GitError::command("repository ownership", "The repository directory moved or was replaced. Git changes were stopped; refresh the repository before retrying.")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn git(repo: &Path, args: &[&str]) -> super::super::types::GitOutput {
        let result = super::super::process::run_git(
            &WorkspaceEnv::Local,
            Some(repo.to_str().unwrap()),
            args,
            20,
        )
        .unwrap();
        assert_eq!(
            result.exit_code,
            Some(0),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        result
    }
    fn repository(path: &Path) {
        std::fs::create_dir(path).unwrap();
        git(path, &["init", "-q"]);
        std::fs::write(path.join("file"), "initial").unwrap();
        git(path, &["add", "file"]);
        git(
            path,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "seed",
            ],
        );
    }
    fn owned(path: &Path) -> super::super::utils::ResolvedGitDirectory {
        let registry = crate::modules::workspace::WorkspaceRegistry::default();
        registry.authorize(path).unwrap();
        super::super::utils::owned_repo_root(
            &registry,
            path.to_str().unwrap(),
            &WorkspaceEnv::Local,
        )
        .unwrap()
    }
    #[test]
    fn linked_worktrees_retain_their_own_index_and_shared_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main");
        let linked = temp.path().join("linked");
        repository(&main);
        git(
            &main,
            &["worktree", "add", "-qb", "linked", linked.to_str().unwrap()],
        );
        let repo = owned(&linked);
        std::fs::write(linked.join("file"), "linked edit").unwrap();
        assert_eq!(repo.run(["add", "file"], 20).unwrap().exit_code, Some(0));
        assert!(git(&main, &["diff", "--cached", "--name-only"])
            .stdout
            .is_empty());
        assert_eq!(git(&linked, &["show", ":file"]).stdout, b"linked edit");
    }
    #[test]
    fn linked_authorization_requires_a_current_exact_backlink() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main");
        let linked = temp.path().join("linked");
        repository(&main);
        git(
            &main,
            &["worktree", "add", "-qb", "linked", linked.to_str().unwrap()],
        );
        let repo = owned(&linked);
        let backlink = repo.ownership.as_ref().unwrap().git.path().join("gitdir");
        std::fs::write(&backlink, main.join(".git").to_str().unwrap()).unwrap();
        assert!(repo.run(["status", "--porcelain"], 20).is_err());
        let registry = WorkspaceRegistry::default();
        registry.authorize(&linked).unwrap();
        assert!(super::super::utils::owned_repo_root(
            &registry,
            linked.to_str().unwrap(),
            &WorkspaceEnv::Local
        )
        .is_err());
        assert!(super::super::utils::authorized_repo_root(
            &registry,
            linked.to_str().unwrap(),
            &WorkspaceEnv::Local
        )
        .is_err());
    }
    #[test]
    fn bare_repositories_can_still_manage_worktrees() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main");
        let bare = temp.path().join("bare.git");
        let linked = temp.path().join("linked");
        repository(&main);
        git(
            &main,
            &[
                "clone",
                "-q",
                "--bare",
                main.to_str().unwrap(),
                bare.to_str().unwrap(),
            ],
        );
        let repo = owned(&bare);
        let output = repo
            .run(
                ["worktree", "add", "-qb", "linked", linked.to_str().unwrap()],
                20,
            )
            .unwrap();
        assert_eq!(
            output.exit_code,
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            std::fs::read_to_string(linked.join("file")).unwrap(),
            "initial"
        );
    }
    #[test]
    fn changed_gitfile_or_commondir_is_rejected_before_running() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main");
        let other = temp.path().join("other");
        let linked = temp.path().join("linked");
        repository(&main);
        repository(&other);
        git(
            &main,
            &["worktree", "add", "-qb", "linked", linked.to_str().unwrap()],
        );
        let repo = owned(&linked);
        let original = std::fs::read(linked.join(".git")).unwrap();
        std::fs::write(
            linked.join(".git"),
            format!("gitdir: {}\n", other.join(".git").display()),
        )
        .unwrap();
        assert!(repo.run(["add", "file"], 20).is_err());
        std::fs::write(linked.join(".git"), original).unwrap();
        let gitdir = repo.ownership.as_ref().unwrap().git.path();
        std::fs::write(
            gitdir.join("commondir"),
            other.join(".git").to_str().unwrap(),
        )
        .unwrap();
        assert!(repo.run(["add", "file"], 20).is_err());
        assert!(git(&other, &["diff", "--cached", "--name-only"])
            .stdout
            .is_empty());
    }
    #[test]
    fn a_late_core_worktree_change_cannot_redirect_the_prepared_command() {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        repository(&a);
        repository(&b);
        let repo = owned(&a);
        std::fs::write(a.join("file"), "a edit").unwrap();
        std::fs::write(b.join("file"), "b edit").unwrap();
        git(&a, &["config", "core.worktree", b.to_str().unwrap()]);
        assert_eq!(
            repo.run(["restore", "--worktree", "--", "file"], 20)
                .unwrap()
                .exit_code,
            Some(0)
        );
        assert_eq!(std::fs::read_to_string(a.join("file")).unwrap(), "initial");
        assert_eq!(std::fs::read_to_string(b.join("file")).unwrap(), "b edit");
    }
    #[cfg(unix)]
    #[test]
    fn metadata_replacement_between_configuration_and_spawn_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        repository(&a);
        repository(&b);
        let repo = owned(&a);
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "touch marker"]);
        repo.ownership.unwrap().configure(&mut cmd).unwrap();
        std::fs::rename(a.join(".git"), a.join("original-git")).unwrap();
        std::os::unix::fs::symlink(b.join(".git"), a.join(".git")).unwrap();
        assert!(cmd.status().is_err());
        assert!(!a.join("marker").exists());
    }
    #[cfg(unix)]
    #[test]
    fn replacement_between_configuration_and_spawn_cannot_run_in_the_new_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let a = root.join("a");
        let b = root.join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        let owner = DirectoryPin::acquire(&a, &WorkspaceEnv::Local).unwrap();
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "printf wrong > marker"]);
        owner.configure(&mut cmd).unwrap();
        std::fs::rename(&a, root.join("original-a")).unwrap();
        std::os::unix::fs::symlink(&b, &a).unwrap();
        assert!(cmd.status().is_err());
        assert!(!b.join("marker").exists());
        assert!(!root.join("original-a/marker").exists());
    }
    #[cfg(unix)]
    #[test]
    fn a_new_directory_at_the_same_name_is_a_different_owner() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let a = root.join("a");
        std::fs::create_dir(&a).unwrap();
        let owner = DirectoryPin::acquire(&a, &WorkspaceEnv::Local).unwrap();
        std::fs::rename(&a, root.join("old")).unwrap();
        std::fs::create_dir(&a).unwrap();
        assert!(owner.validate().is_err());
    }
    #[cfg(unix)]
    #[test]
    fn parent_rename_invalidates_the_owner_but_file_edits_do_not() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let parent = root.join("parent");
        let repo = parent.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let owner = DirectoryPin::acquire(&repo, &WorkspaceEnv::Local).unwrap();
        std::fs::write(repo.join("file"), "edit").unwrap();
        owner.validate().unwrap();
        std::fs::rename(parent, root.join("moved")).unwrap();
        assert!(owner.validate().is_err());
    }
    #[cfg(unix)]
    #[test]
    fn child_cwd_is_owned_without_changing_the_app_cwd() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let before = std::env::current_dir().unwrap();
        let owner = DirectoryPin::acquire(&root, &WorkspaceEnv::Local).unwrap();
        let mut cmd = Command::new("/bin/pwd");
        owner.configure(&mut cmd).unwrap();
        let output = cmd.output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            root.to_str().unwrap()
        );
        assert_eq!(std::env::current_dir().unwrap(), before);
    }
    #[test]
    fn wsl_never_falls_back_to_path_only_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let error = DirectoryPin::acquire(
            temp.path(),
            &WorkspaceEnv::Wsl {
                distro: "Ubuntu".into(),
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("Linux-side directory ownership"));
    }
    #[cfg(windows)]
    #[test]
    fn windows_ownership_prevents_repository_and_ancestor_rename_until_release() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("parent");
        let repo = parent.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let owner = DirectoryPin::acquire(&repo, &WorkspaceEnv::Local).unwrap();
        assert!(std::fs::rename(&repo, parent.join("other")).is_err());
        assert!(std::fs::rename(&parent, temp.path().join("moved")).is_err());
        drop(owner);
        std::fs::rename(&parent, temp.path().join("moved")).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn a_running_git_filter_cannot_redirect_index_writes_into_a_replacement_repo() {
        use super::super::{process::run_git, utils::owned_repo_root};
        use crate::modules::workspace::WorkspaceRegistry;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let a = root.join("a");
        let b = root.join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        let git = |repo: &Path, args: Vec<&str>| {
            let output =
                run_git(&WorkspaceEnv::Local, Some(repo.to_str().unwrap()), args, 20).unwrap();
            assert_eq!(
                output.exit_code,
                Some(0),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            output
        };
        for repo in [&a, &b] {
            std::fs::write(repo.join("file"), "HEAD").unwrap();
            std::fs::write(repo.join(".gitattributes"), "file filter=hold\n").unwrap();
            git(repo, vec!["init", "-q"]);
            git(repo, vec!["add", "."]);
            git(
                repo,
                vec![
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-q",
                    "-m",
                    "seed",
                ],
            );
        }
        let script = root.join("hold.sh");
        let entered = root.join("entered");
        let resume = root.join("resume");
        std::fs::write(
            &script,
            r#"touch "$1"; while [ ! -e "$2" ]; do sleep 0.01; done; cat"#,
        )
        .unwrap();
        let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
        let filter = format!(
            "sh {} {} {}",
            quote(&script),
            quote(&entered),
            quote(&resume)
        );
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        let owner = owned_repo_root(&registry, a.to_str().unwrap(), &WorkspaceEnv::Local).unwrap();
        // A different local process adds the filter after admission; this
        // exercises the documented best-effort race, not the static guard.
        git(&a, vec!["config", "filter.hold.clean", &filter]);
        std::fs::write(a.join("file"), "a edit").unwrap();
        std::fs::write(b.join("file"), "b edit").unwrap();
        let worker = std::thread::spawn(move || owner.run(["add", "file"], 20));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !entered.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let started = entered.exists();
        if started {
            std::fs::rename(&a, root.join("original-a")).unwrap();
            std::os::unix::fs::symlink(&b, &a).unwrap();
        }
        std::fs::write(&resume, "").unwrap();
        let result = worker.join().unwrap();
        assert!(started, "Git never reached its filter");
        assert!(result.is_err());
        assert!(git(&b, vec!["diff", "--cached", "--name-only"])
            .stdout
            .is_empty());
        assert_eq!(std::fs::read_to_string(b.join("file")).unwrap(), "b edit");
    }
}
