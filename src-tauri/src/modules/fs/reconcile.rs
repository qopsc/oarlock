//! Reconcile open document identities after mutation delivery is interrupted.
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use super::{attachment::handle_path, blocking, display_path, document_save};
use crate::modules::{
    project_trust::open_regular,
    workspace::{resolve_path, Origin, WorkspaceEnv, WorkspaceRegistry},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    id: u64,
    path: String,
    version: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    id: u64,
    path: Option<String>,
}

struct Root {
    path: PathBuf,
    display: String,
}

/// Each walk gets its own budget, so one large root (a home folder, a monorepo) cannot starve
/// the rest, and spending it only leaves the documents it would have found unresolved.
#[derive(Clone, Copy)]
struct Limits {
    entries: usize,
    time: Duration,
}

const LIMITS: Limits = Limits {
    entries: 100_000,
    time: Duration::from_secs(5),
};

fn version_identity(version: &str) -> Option<&str> {
    version
        .strip_prefix("v2:")?
        .rsplit_once(':')
        .map(|(identity, _)| identity)
        // The placeholder of a save whose version could not be read back names no file.
        .filter(|identity| *identity != "unavailable")
}

fn opened_identity(
    path: &Path,
    authorize: &impl Fn(&Path) -> Result<(), String>,
) -> Result<String, String> {
    let file = open_regular(path).map_err(|e| e.to_string())?;
    authorize(&handle_path(&file)?)?;
    document_save::identity(&file).map_err(|e| e.to_string())
}

#[cfg(unix)]
fn might_match(meta: &fs::Metadata, identities: &HashMap<String, Vec<usize>>) -> bool {
    use std::os::unix::fs::MetadataExt;
    let prefix = format!("{}:{}:", meta.dev(), meta.ino());
    identities
        .keys()
        .any(|identity| identity.starts_with(&prefix))
}
#[cfg(not(unix))]
fn might_match(_: &fs::Metadata, _: &HashMap<String, Vec<usize>>) -> bool {
    true
}

fn reconcile(
    documents: &[Document],
    roots: &[Root],
    workspace: &WorkspaceEnv,
    authorize: impl Fn(&Path) -> Result<(), String>,
) -> Result<Vec<Binding>, String> {
    reconcile_within(documents, roots, workspace, authorize, LIMITS)
}

fn reconcile_within(
    documents: &[Document],
    roots: &[Root],
    workspace: &WorkspaceEnv,
    authorize: impl Fn(&Path) -> Result<(), String>,
    limits: Limits,
) -> Result<Vec<Binding>, String> {
    let mut bindings: Vec<_> = documents
        .iter()
        .map(|doc| Binding {
            id: doc.id,
            path: None,
        })
        .collect();
    let mut unresolved: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, doc) in documents.iter().enumerate() {
        let requested = resolve_path(&doc.path, workspace)?;
        let expected = doc.version.as_deref().and_then(version_identity);
        if let Ok(actual) = opened_identity(&requested, &authorize) {
            if expected.is_none_or(|identity| identity == actual) {
                bindings[i].path = Some(doc.path.clone());
                continue;
            }
        }
        // Without a native version there is nothing to prove a file at the old name or at the
        // rename destination is this document, so it stays unresolved rather than guessed.
        if let Some(identity) = expected {
            unresolved.entry(identity.to_owned()).or_default().push(i);
        }
    }
    if unresolved.is_empty() {
        return Ok(bindings);
    }
    // A hard-linked file may have several names. Never choose one arbitrarily.
    let mut matches: HashMap<String, Option<String>> = HashMap::new();
    let deadline = Instant::now() + limits.time;
    // A rename usually stays in the folder the document came from: look there first, for the
    // documents still unresolved only. The walk starts at the root so its ignore rules apply.
    let mut formers: Vec<(PathBuf, usize)> = Vec::new();
    for indexes in unresolved.values() {
        for &i in indexes {
            let former = resolve_path(&documents[i].path, workspace)
                .ok()
                .and_then(|path| path.parent().map(Path::to_path_buf))
                .and_then(|dir| fs::canonicalize(dir).ok());
            let Some(former) = former else { continue };
            let Some(root) = roots.iter().position(|root| former.starts_with(&root.path)) else {
                continue;
            };
            if !formers.iter().any(|(done, _)| former.starts_with(done)) {
                formers.push((former, root));
            }
        }
    }
    let scan = |root: &Root, only: Option<&Path>, skip: &[PathBuf], matches: &mut HashMap<String, Option<String>>| {
        let mut seen = 0usize;
        let only = only.map(Path::to_path_buf);
        let skip = skip.to_vec();
        let walker = WalkBuilder::new(&root.path)
            .hidden(false)
            .ignore(true)
            .git_ignore(true)
            .git_global(false)
            .git_exclude(true)
            .require_git(false)
            .parents(false)
            .follow_links(false)
            .filter_entry(move |entry| {
                let path = entry.path();
                entry.file_name() != ".git"
                    && !skip.iter().any(|done| path.starts_with(done))
                    && only
                        .as_ref()
                        .is_none_or(|target| path.starts_with(target) || target.starts_with(path))
            })
            .build();
        for entry in walker {
            seen += 1;
            if seen > limits.entries || Instant::now() > deadline {
                return;
            }
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if !might_match(&meta, &unresolved) {
                continue;
            }
            let Ok(identity) = opened_identity(entry.path(), &authorize) else {
                continue;
            };
            if !unresolved.contains_key(&identity) {
                continue;
            }
            let path = display_path(entry.path(), &root.path, &root.display, workspace);
            matches
                .entry(identity)
                .and_modify(|old| {
                    if old.as_ref().is_some_and(|prior| prior != &path) {
                        *old = None;
                    }
                })
                .or_insert(Some(path));
        }
    };
    for (former, root) in &formers {
        scan(&roots[*root], Some(former), &[], &mut matches);
    }
    let done: Vec<PathBuf> = formers.into_iter().map(|(former, _)| former).collect();
    for root in roots {
        scan(root, None, &done, &mut matches);
    }
    for (identity, indexes) in unresolved {
        if let Some(Some(path)) = matches.get(&identity) {
            for i in indexes {
                bindings[i].path = Some(path.clone());
            }
        }
    }
    Ok(bindings)
}

/// A root that is gone, not a folder or out of reach is skipped: its documents stay
/// unresolved instead of stalling the whole batch.
fn usable_roots(
    displays: Vec<String>,
    workspace: &WorkspaceEnv,
    authorize: impl Fn(&Path) -> Result<PathBuf, String>,
) -> Result<Vec<Root>, String> {
    let mut roots = Vec::new();
    for display in displays {
        let requested = resolve_path(&display, workspace)?;
        match authorize(&requested) {
            Ok(path) if path.is_dir() => roots.push(Root { path, display }),
            _ => {}
        }
    }
    Ok(roots)
}

#[tauri::command]
pub async fn fs_reconcile_documents(
    app: tauri::AppHandle,
    workspace: Option<WorkspaceEnv>,
    roots: Vec<String>,
    documents: Vec<Document>,
) -> Result<Vec<Binding>, String> {
    blocking(move || {
        if roots.len() > 128 || documents.len() > 4096 {
            return Err("Too many documents to reconcile".into());
        }
        let workspace = WorkspaceEnv::from_option(workspace);
        let registry = app.state::<WorkspaceRegistry>();
        let gates = registry.gates(Origin::App);
        let roots = usable_roots(roots, &workspace, |path| gates.authorized_existing(path))?;
        reconcile(&documents, &roots, &workspace, |path| {
            gates.authorized_existing(path).map(drop)
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_document_without_a_version_keeps_its_path_but_never_adopts_a_destination() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::write(&source, "source").unwrap();
        fs::write(&destination, "destination").unwrap();
        let docs = vec![Document {
            id: 1,
            path: source.to_string_lossy().into(),
            version: None,
        }];
        let roots = vec![Root {
            path: temp.path().into(),
            display: temp.path().to_string_lossy().into(),
        }];
        let find = || reconcile(&docs, &roots, &WorkspaceEnv::default(), |_| Ok(())).unwrap();
        assert_eq!(find()[0].path.as_deref(), source.to_str());
        fs::remove_file(&source).unwrap();
        assert_eq!(
            find()[0].path,
            None,
            "a destination is never adopted without an identity to match"
        );
        fs::remove_file(&destination).unwrap();
        assert_eq!(find()[0].path, None);
    }

    #[test]
    fn missed_rename_without_identity_or_destination_cannot_be_inferred() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::write(&destination, "saved document").unwrap();
        let docs = vec![Document {
            id: 1,
            path: source.to_string_lossy().into(),
            version: None,
        }];
        let roots = vec![Root {
            path: temp.path().into(),
            display: temp.path().to_string_lossy().into(),
        }];
        let bindings = reconcile(&docs, &roots, &WorkspaceEnv::default(), |_| Ok(())).unwrap();
        assert_eq!(bindings[0].path, None);
    }

    #[test]
    fn partial_rename_uses_identity_when_source_and_destination_exist() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::write(&source, "original").unwrap();
        let file = fs::File::open(&source).unwrap();
        let version = document_save::version(&file, b"original").unwrap();
        let docs = vec![Document {
            id: 1,
            path: source.to_string_lossy().into(),
            version: Some(version),
        }];
        let roots = vec![Root {
            path: temp.path().into(),
            display: temp.path().to_string_lossy().into(),
        }];
        let find = || reconcile(&docs, &roots, &WorkspaceEnv::default(), |_| Ok(())).unwrap();

        // The attempted rename left both entries in place: retain the source.
        fs::write(&destination, "unrelated destination").unwrap();
        assert_eq!(find()[0].path.as_deref(), source.to_str());
        assert_eq!(find(), find());

        // The rename succeeded, but another file was created at the old name.
        fs::remove_file(&destination).unwrap();
        fs::rename(&source, &destination).unwrap();
        assert_eq!(find()[0].path.as_deref(), destination.to_str());
        fs::write(&source, "replacement").unwrap();
        assert_eq!(find()[0].path.as_deref(), destination.to_str());
        assert_eq!(find(), find());
    }

    #[test]
    fn finds_a_missed_rename_and_does_not_choose_ambiguous_hardlinks() {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        fs::write(&a, "draft baseline").unwrap();
        let file = fs::File::open(&a).unwrap();
        let version = document_save::version(&file, b"draft baseline").unwrap();
        fs::rename(&a, &b).unwrap();
        let docs = vec![Document {
            id: 1,
            path: a.to_string_lossy().into(),
            version: Some(version),
        }];
        let roots = vec![Root {
            path: temp.path().into(),
            display: temp.path().to_string_lossy().into(),
        }];
        let find = || reconcile(&docs, &roots, &WorkspaceEnv::default(), |_| Ok(())).unwrap();
        assert_eq!(find()[0].path.as_deref(), b.to_str());
        fs::hard_link(&b, temp.path().join("c")).unwrap();
        assert_eq!(find()[0].path, None);
    }

    fn versioned(dir: &Path, name: &str) -> (PathBuf, Document) {
        let file = dir.join(name);
        fs::write(&file, name).unwrap();
        let handle = fs::File::open(&file).unwrap();
        let version = document_save::version(&handle, name.as_bytes()).unwrap();
        let doc = Document {
            id: 1,
            path: file.to_string_lossy().into(),
            version: Some(version),
        };
        (file, doc)
    }

    #[test]
    fn a_missing_or_unauthorized_root_is_skipped_not_fatal() {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let good = base.join("good");
        let denied = base.join("denied");
        fs::create_dir_all(&good).unwrap();
        fs::create_dir_all(&denied).unwrap();
        let shown = |p: &Path| p.to_string_lossy().into_owned();
        let roots = usable_roots(
            vec![shown(&base.join("gone")), shown(&denied), shown(&good)],
            &WorkspaceEnv::default(),
            |path| {
                if path.starts_with(&denied) {
                    Err("outside".into())
                } else {
                    fs::canonicalize(path).map_err(|e| e.to_string())
                }
            },
        )
        .unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].path, good);
    }

    #[test]
    fn the_unavailable_placeholder_matches_the_file_at_its_own_path() {
        assert_eq!(version_identity("v2:unavailable:abcd"), None);
        assert_eq!(version_identity("v2:1:2:birth:x:abcd"), Some("1:2:birth:x"));
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("doc");
        fs::write(&file, "x").unwrap();
        let doc = Document {
            id: 1,
            path: file.to_string_lossy().into(),
            version: Some("v2:unavailable:abcd".into()),
        };
        let found = reconcile(&[doc], &[root(temp.path())], &WorkspaceEnv::default(), |_| Ok(())).unwrap();
        assert_eq!(found[0].path.as_deref(), file.to_str());
    }

    #[test]
    fn a_former_folder_is_walked_once_and_only_for_unresolved_documents() {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let sub = base.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(base.join(".gitignore"), "ignored/\n").unwrap();
        fs::create_dir_all(sub.join("ignored")).unwrap();
        let (original, doc) = versioned(&sub, "doc.txt");
        let hidden = sub.join("ignored/doc.txt");
        fs::rename(&original, &hidden).unwrap();
        let found = reconcile(&[doc], &[root(&base)], &WorkspaceEnv::default(), |_| Ok(())).unwrap();
        assert_eq!(found[0].path, None, "the root's ignore rules apply inside a former folder");
    }

    fn root(path: &Path) -> Root {
        Root {
            path: fs::canonicalize(path).unwrap(),
            display: path.to_string_lossy().into(),
        }
    }

    #[test]
    fn ignored_folders_and_git_internals_are_not_walked() {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        fs::create_dir_all(base.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(base.join(".git/objects")).unwrap();
        fs::write(base.join(".gitignore"), "node_modules/\n").unwrap();
        let (original, doc) = versioned(&base, "doc.txt");
        let hidden = base.join("node_modules/pkg/doc.txt");
        fs::rename(&original, &hidden).unwrap();
        let roots = [root(&base)];
        let found = reconcile(&[doc], &roots, &WorkspaceEnv::default(), |_| Ok(())).unwrap();
        assert_eq!(found[0].path, None, "an ignored folder is outside the walk");
    }

    #[test]
    fn each_root_has_its_own_budget_and_exhaustion_leaves_documents_unresolved() {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let (big, small) = (base.join("big"), base.join("small"));
        fs::create_dir_all(&big).unwrap();
        fs::create_dir_all(&small).unwrap();
        for n in 0..200 {
            fs::write(big.join(format!("f{n}")), "x").unwrap();
        }
        let (original, doc) = versioned(&small, "doc.txt");
        let moved = small.join("renamed.txt");
        fs::rename(&original, &moved).unwrap();
        let limits = Limits {
            entries: 50,
            time: Duration::from_secs(30),
        };
        let run = |roots: &[Root]| {
            reconcile_within(&[doc_copy(&doc)], roots, &WorkspaceEnv::default(), |_| Ok(()), limits)
        };
        let only_big = run(&[root(&big)]).unwrap();
        assert_eq!(only_big[0].path, None, "the exhausted walk does not fail the batch");
        let both = run(&[root(&big), root(&small)]).unwrap();
        assert_eq!(both[0].path.as_deref(), moved.to_str());
    }

    fn doc_copy(doc: &Document) -> Document {
        Document {
            id: doc.id,
            path: doc.path.clone(),
            version: doc.version.clone(),
        }
    }

    #[test]
    fn the_former_folder_is_searched_before_the_roots() {
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let (aaa, zzz) = (base.join("aaa"), base.join("zzz"));
        fs::create_dir_all(&aaa).unwrap();
        fs::create_dir_all(&zzz).unwrap();
        for n in 0..200 {
            fs::write(aaa.join(format!("f{n}")), "x").unwrap();
        }
        let (original, doc) = versioned(&zzz, "doc.txt");
        let moved = zzz.join("renamed.txt");
        fs::rename(&original, &moved).unwrap();
        let limits = Limits {
            entries: 50,
            time: Duration::from_secs(30),
        };
        let found = reconcile_within(
            &[doc],
            &[root(&base)],
            &WorkspaceEnv::default(),
            |_| Ok(()),
            limits,
        )
        .unwrap();
        assert_eq!(found[0].path.as_deref(), moved.to_str());
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_folder_does_not_fail_the_batch() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(temp.path()).unwrap();
        let locked = base.join("locked");
        fs::create_dir_all(&locked).unwrap();
        let (original, doc) = versioned(&base, "doc.txt");
        let moved = base.join("renamed.txt");
        fs::rename(&original, &moved).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let found = reconcile(&[doc], &[root(&base)], &WorkspaceEnv::default(), |_| Ok(()));
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(found.unwrap()[0].path.as_deref(), moved.to_str());
    }
}
