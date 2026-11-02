//! Source Control Discard. Native resolves the repository once, names the entries
//! it will rewrite to every window (`discard-begin` / `discard-end` on the
//! mutation stream) and runs Git between the two events.
use super::{operations, types::DiscardEntry, utils};
use crate::modules::{
    fs::mutation_events,
    workspace::{resolve_path, Origin, WorkspaceEnv, WorkspaceRegistry},
};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Clone)]
struct Work {
    repo: Option<utils::ResolvedGitDirectory>,
    entries: Vec<DiscardEntry>,
}
impl Work {
    fn execute(&self, registry: &WorkspaceRegistry, guard: &impl Fn(&std::path::Path) -> Result<(), String>) -> Result<(), String> {
        let repo = self
            .repo
            .as_ref()
            .ok_or("Prepared repository ownership is missing")?;
        for entry in &self.entries {
            let path = utils::git_worktree_entry(&repo.local_path, &entry.path).map_err(|e| e.to_string())?;
            guard_tree(&path, guard)?;
        }
        operations::discard_owned(registry, repo, &self.entries).map_err(|e| e.to_string())
    }
}

#[cfg(unix)]
fn guard_tree(path: &std::path::Path, guard: &impl Fn(&std::path::Path) -> Result<(), String>) -> Result<(), String> {
    use std::{fs, os::unix::fs::MetadataExt};
    guard(path)?;
    let mut pending = vec![path.to_path_buf()];
    let mut visited = 0usize;
    while let Some(current) = pending.pop() {
        let meta = match fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        if !meta.is_dir() { continue; }
        for entry in fs::read_dir(&current).map_err(|e| e.to_string())? {
            visited += 1;
            if visited > 32_768 { return Err("Too many discard entries to verify safely".into()); }
            let entry = entry.map_err(|e| e.to_string())?;
            let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if meta.is_dir() { pending.push(entry.path()); }
            else if meta.file_type().is_symlink() || meta.is_file() && meta.nlink() > 1 {
                guard(&entry.path())?;
            }
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn guard_tree(_: &std::path::Path, _: &impl Fn(&std::path::Path) -> Result<(), String>) -> Result<(), String> {
    Err("Safe Git discard checks are unavailable on this platform".into())
}
struct Scope {
    paths: Vec<String>,
    workspace: WorkspaceEnv,
}
impl Scope {
    fn confirm(&self, roots: &[String]) -> Result<(), String> {
        if self.paths == roots {
            Ok(())
        } else {
            Err("The repository changed since Discard was confirmed; try again".into())
        }
    }
}
fn plan(
    registry: &WorkspaceRegistry,
    root: String,
    entries: Vec<DiscardEntry>,
    workspace: WorkspaceEnv,
) -> Result<(Scope, Work), String> {
    let repo = utils::owned_repo_root(registry, &root, &workspace).map_err(|e| e.to_string())?;
    let mut paths = Vec::new();
    for entry in &entries {
        utils::git_worktree_entry(&repo.local_path, &entry.path).map_err(|e| e.to_string())?;
        let path = utils::git_entry_name(&entry.path).map_err(|e| e.to_string())?;
        paths.push(format!("{}/{}", repo.git_path.trim_end_matches('/'), path));
    }
    Ok((
        Scope {
            paths,
            workspace: workspace.clone(),
        },
        Work {
            repo: Some(repo),
            entries,
        },
    ))
}
/// Resolve both the document's entry and its read target. Git operates on an
/// entry (including a symlink), whereas an editor may have opened its target.
/// No file contents are read, and no path spelling or cached identity from the
/// webview can authorize or decide this match.
fn match_documents(
    registry: &WorkspaceRegistry,
    scope: &Scope,
    paths: &[String],
) -> Result<Vec<bool>, String> {
    let roots = scope
        .paths
        .iter()
        .map(|path| resolve_path(path, &scope.workspace))
        .collect::<Result<Vec<_>, _>>()?;
    let gates = registry.gates(Origin::App);
    let comparable = |path: &std::path::Path| {
        let path = crate::modules::fs::to_canon(path);
        if cfg!(any(windows, target_os = "macos")) {
            path.to_lowercase()
        } else {
            path
        }
    };
    let roots: Vec<_> = roots.iter().map(|path| comparable(path)).collect();
    paths
        .iter()
        .map(|path| {
            let requested = resolve_path(path, &scope.workspace)?;
            let parent = requested
                .parent()
                .ok_or("Document has no parent directory")?;
            let name = requested.file_name().ok_or("Document has no file name")?;
            let entry = gates.authorized_new(parent)?.join(name);
            let target = gates.authorized_write_target(&requested)?;
            let names = [comparable(&entry), comparable(&target)];
            Ok(names.iter().any(|name| {
                roots.iter().any(|root| {
                    name == root || name.starts_with(&format!("{}/", root.trim_end_matches('/')))
                })
            }))
        })
        .collect()
}
#[tauri::command]
pub async fn git_discard_scope(
    app: AppHandle,
    repo_root: String,
    entries: Vec<DiscardEntry>,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<String>, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    crate::modules::fs::blocking(move || {
        plan(&app.state::<WorkspaceRegistry>(), repo_root, entries, workspace)
            .map(|(scope, _)| scope.paths)
    })
    .await
}
#[tauri::command]
pub async fn git_discard_match(
    app: AppHandle,
    roots: Vec<String>,
    paths: Vec<String>,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<bool>, String> {
    let scope = Scope {
        paths: roots,
        workspace: WorkspaceEnv::from_option(workspace),
    };
    crate::modules::fs::blocking(move || {
        match_documents(&app.state::<WorkspaceRegistry>(), &scope, &paths)
    })
    .await
}
/// The only way `execute` gets its work: the repository must still resolve to the
/// roots the user confirmed, so a retargeted alias cannot move Git elsewhere.
fn prepare(
    registry: &WorkspaceRegistry,
    root: String,
    entries: Vec<DiscardEntry>,
    workspace: WorkspaceEnv,
    roots: &[String],
) -> Result<(Scope, Work), String> {
    let (scope, work) = plan(registry, root, entries, workspace)?;
    scope.confirm(roots)?;
    Ok((scope, work))
}
/// Runs Git for entries confirmed against `roots`; a repository that no longer
/// resolves to those roots is refused before anything is announced or run.
pub async fn execute(
    app: AppHandle,
    origin: String,
    repo_root: String,
    entries: Vec<DiscardEntry>,
    workspace: WorkspaceEnv,
    roots: Vec<String>,
) -> Result<(), String> {
    crate::modules::fs::blocking(move || {
        let (scope, work) = prepare(
            &app.state::<WorkspaceRegistry>(),
            repo_root.clone(),
            entries,
            workspace.clone(),
            &roots,
        )?;
        let claims: Vec<PathBuf> = scope.paths.iter().map(PathBuf::from).collect();
        let discarding = mutation_events::Discarding {
            origin,
            repo_root,
            roots: scope.paths,
        };
        mutation_events::discard_bracket(&app, workspace, &claims, discarding, || {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let dirs = crate::modules::fs::native_store::store_dirs(&app)?;
                let guard = super::utils::store_guard(&dirs);
                work.execute(&app.state::<WorkspaceRegistry>(), &guard)
            }))
            .unwrap_or_else(|_| {
                Err("Git Discard failed unexpectedly; editor drafts were retained".into())
            })
        })
    })
    .await
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    use std::{fs, path::Path};
    fn scope(path: &Path) -> Scope {
        Scope {
            paths: vec![path.to_string_lossy().into_owned()],
            workspace: WorkspaceEnv::Local,
        }
    }
    fn paths(path: &Path) -> Vec<String> {
        vec![path.to_string_lossy().into_owned()]
    }
    #[cfg(unix)]
    #[test]
    fn directory_and_leaf_aliases_match_native_entry_and_read_target() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let repo = root.join("repo");
        fs::create_dir(&repo).unwrap();
        fs::write(repo.join("file"), "working tree").unwrap();
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&repo, &alias).unwrap();
        let leaf = repo.join("link");
        std::os::unix::fs::symlink("file", &leaf).unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        assert_eq!(
            match_documents(
                &registry,
                &scope(&repo.join("file")),
                &paths(&alias.join("./file"))
            )
            .unwrap(),
            vec![true]
        );
        assert_eq!(
            match_documents(&registry, &scope(&repo.join("file")), &paths(&leaf)).unwrap(),
            vec![true]
        );
        assert_eq!(
            match_documents(&registry, &scope(&leaf), &paths(&leaf)).unwrap(),
            vec![true]
        );
        // Discarding the symlink entry does not write the separate target editor.
        assert_eq!(
            match_documents(&registry, &scope(&leaf), &paths(&repo.join("file"))).unwrap(),
            vec![false]
        );
    }
    #[test]
    fn deleted_files_and_directory_descendants_keep_identity_without_prefix_collisions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        let deleted = root.join("gone");
        assert_eq!(
            match_documents(&registry, &scope(&deleted), &paths(&deleted.join("child"))).unwrap(),
            vec![true]
        );
        assert_eq!(
            match_documents(
                &registry,
                &scope(&deleted),
                &paths(&root.join("gone-other"))
            )
            .unwrap(),
            vec![false]
        );
    }
    #[cfg(unix)]
    #[test]
    fn identities_are_resolved_again_after_alias_retarget_and_outside_paths_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let a = root.join("a");
        let b = root.join("b");
        fs::create_dir(&a).unwrap();
        fs::create_dir(&b).unwrap();
        fs::write(a.join("file"), "a").unwrap();
        fs::write(b.join("file"), "b").unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&a, &link).unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        let target = scope(&a.join("file"));
        let document = paths(&link.join("file"));
        assert_eq!(
            match_documents(&registry, &target, &document).unwrap(),
            vec![true]
        );
        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&b, &link).unwrap();
        assert_eq!(
            match_documents(&registry, &target, &document).unwrap(),
            vec![false]
        );
        let outside = tempfile::tempdir().unwrap();
        assert!(match_documents(&registry, &target, &paths(&outside.path().join("file"))).is_err());
        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        assert!(match_documents(&registry, &target, &document).is_err());
    }
    #[cfg(not(windows))]
    #[test]
    fn unavailable_wsl_identity_does_not_fall_back_to_host_paths() {
        let registry = WorkspaceRegistry::default();
        let scope = Scope {
            paths: vec!["/tmp/file".into()],
            workspace: WorkspaceEnv::Wsl {
                distro: "Ubuntu".into(),
            },
        };
        assert!(match_documents(&registry, &scope, &["/tmp/file".into()]).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn a_prepared_repository_alias_cannot_redirect_the_worker() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let a = root.join("a");
        let b = root.join("b");
        fs::create_dir(&a).unwrap();
        fs::create_dir(&b).unwrap();
        git(&a, vec!["init", "-q"]);
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&a, &alias).unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        let (scope, work) = plan(
            &registry,
            alias.to_string_lossy().into_owned(),
            vec![DiscardEntry {
                path: "file".into(),
                untracked: false,
            }],
            WorkspaceEnv::Local,
        )
        .unwrap();
        fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(&b, &alias).unwrap();
        assert_eq!(std::path::Path::new(&work.repo.unwrap().git_path), a);
        assert_eq!(scope.paths, paths(&a.join("file")));
    }
    #[cfg(unix)]
    #[test]
    fn discard_refuses_roots_confirmed_against_another_repository() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let a = root.join("a");
        let b = root.join("b");
        fs::create_dir(&a).unwrap();
        fs::create_dir(&b).unwrap();
        git(&a, vec!["init", "-q"]);
        git(&b, vec!["init", "-q"]);
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&a, &alias).unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        let entries = || {
            vec![DiscardEntry {
                path: "file".into(),
                untracked: false,
            }]
        };
        let confirmed = plan(
            &registry,
            alias.to_string_lossy().into_owned(),
            entries(),
            WorkspaceEnv::Local,
        )
        .unwrap()
        .0
        .paths;
        let prepared = || {
            prepare(
                &registry,
                alias.to_string_lossy().into_owned(),
                entries(),
                WorkspaceEnv::Local,
                &confirmed,
            )
        };
        assert!(prepared().is_ok());
        fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(&b, &alias).unwrap();
        assert!(prepared().is_err());
    }
    #[cfg(unix)]
    #[test]
    fn replacing_the_prepared_repository_directory_cannot_discard_another_repo() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let a = root.join("a");
        let b = root.join("b");
        fs::create_dir(&a).unwrap();
        fs::create_dir(&b).unwrap();
        for repo in [&a, &b] {
            fs::write(repo.join("file"), "HEAD").unwrap();
            for args in [
                vec!["init", "-q"],
                vec!["add", "file"],
                vec![
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "-q",
                    "-m",
                    "seed",
                ],
            ] {
                let output = crate::modules::git::process::run_git(
                    &WorkspaceEnv::Local,
                    Some(repo.to_str().unwrap()),
                    args,
                    20,
                )
                .unwrap();
                assert_eq!(output.exit_code, Some(0));
            }
        }
        fs::write(a.join("file"), "a edits").unwrap();
        fs::write(b.join("file"), "keep B edits").unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        let (_, work) = plan(
            &registry,
            a.to_string_lossy().into_owned(),
            vec![DiscardEntry {
                path: "file".into(),
                untracked: false,
            }],
            WorkspaceEnv::Local,
        )
        .unwrap();
        fs::rename(&a, root.join("original-a")).unwrap();
        std::os::unix::fs::symlink(&b, &a).unwrap();
        assert!(work.execute(&registry, &|_| Ok(())).is_err());
        assert_eq!(fs::read_to_string(b.join("file")).unwrap(), "keep B edits");
    }

    #[cfg(unix)]
    fn git(repo: &Path, args: Vec<&str>) {
        let output = crate::modules::git::process::run_git(
            &WorkspaceEnv::Local,
            Some(repo.to_str().unwrap()),
            args,
            20,
        )
        .unwrap();
        assert_eq!(
            output.exit_code,
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(unix)]
    fn repositories() -> (
        tempfile::TempDir,
        std::path::PathBuf,
        std::path::PathBuf,
        WorkspaceRegistry,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let a = root.join("a");
        let b = root.join("b");
        for (repo, text) in [(&a, "HEAD-A"), (&b, "HEAD-B")] {
            fs::create_dir(repo).unwrap();
            fs::write(repo.join("file"), text).unwrap();
            git(repo, vec!["init", "-q"]);
            git(repo, vec!["add", "file"]);
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
        fs::write(a.join("file"), "a draft").unwrap();
        fs::write(b.join("file"), "keep B draft").unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&root).unwrap();
        (temp, a, b, registry)
    }
    #[cfg(unix)]
    #[test]
    fn prepared_discard_rejects_git_directory_replacement() {
        let (_temp, a, b, registry) = repositories();
        let (_, work) = plan(
            &registry,
            a.to_str().unwrap().into(),
            vec![DiscardEntry {
                path: "file".into(),
                untracked: false,
            }],
            WorkspaceEnv::Local,
        )
        .unwrap();
        fs::rename(a.join(".git"), a.join("old-git")).unwrap();
        std::os::unix::fs::symlink(b.join(".git"), a.join(".git")).unwrap();
        let result = work.execute(&registry, &|_| Ok(()));
        assert!(
            result.is_err(),
            "discard succeeded using replacement metadata; A now contains {:?}",
            fs::read_to_string(a.join("file")).unwrap()
        );
        assert_eq!(fs::read_to_string(a.join("file")).unwrap(), "a draft");
    }
    #[cfg(unix)]
    #[test]
    fn protected_file_is_not_discarded() {
        let (_temp, repo, _other, registry) = repositories();
        let (_, work) = plan(&registry, repo.to_str().unwrap().into(), vec![DiscardEntry {
            path: "file".into(), untracked: false,
        }], WorkspaceEnv::Local).unwrap();
        let protected = repo.join("file");
        assert!(work.execute(&registry, &|path| {
            if path == protected { Err("Protected native store".into()) } else { Ok(()) }
        }).is_err());
        assert_eq!(fs::read_to_string(protected).unwrap(), "a draft");
    }
    #[cfg(unix)]
    #[test]
    fn discard_refuses_a_hard_link_to_a_native_store_with_the_real_check() {
        use crate::modules::fs::native_store::StoreDirs;
        let (temp, repo, _other, registry) = repositories();
        let data = temp.path().canonicalize().unwrap().join("data");
        fs::create_dir_all(data.join("windows")).unwrap();
        let store = data.join("windows/state.json");
        fs::write(&store, "native").unwrap();
        let dirs = StoreDirs::under(&data, &data, &data, Vec::new());
        let (_, work) = plan(&registry, repo.to_str().unwrap().into(), vec![DiscardEntry {
            path: "file".into(), untracked: false,
        }], WorkspaceEnv::Local).unwrap();
        fs::remove_file(repo.join("file")).unwrap();
        fs::hard_link(&store, repo.join("file")).unwrap();
        let error = work
            .execute(&registry, &utils::store_guard(&dirs))
            .unwrap_err();
        assert!(error.contains("native-owned"), "{error}");
        assert_eq!(fs::read_to_string(&store).unwrap(), "native");
    }
    #[cfg(unix)]
    #[test]
    fn protected_alias_inside_discarded_folder_is_detected() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("untracked");
        fs::create_dir(&folder).unwrap();
        let protected = root.path().join("protected");
        let alias = folder.join("alias");
        fs::write(&protected, "keep").unwrap();
        fs::hard_link(&protected, &alias).unwrap();
        assert!(guard_tree(&folder, &|path| {
            if path == alias { Err("Protected native store".into()) } else { Ok(()) }
        }).is_err());
        assert_eq!(fs::read_to_string(protected).unwrap(), "keep");
        assert!(alias.exists());
    }
    #[cfg(unix)]
    #[test]
    fn discard_never_follows_a_configured_foreign_worktree() {
        let (_temp, a, b, registry) = repositories();
        git(&a, vec!["config", "core.worktree", b.to_str().unwrap()]);
        assert!(plan(
            &registry,
            a.to_str().unwrap().into(),
            vec![DiscardEntry {
                path: "file".into(),
                untracked: false
            }],
            WorkspaceEnv::Local
        )
        .is_err());
        assert_eq!(fs::read_to_string(b.join("file")).unwrap(), "keep B draft");
    }
}
