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
    alternate_path: Option<String>,
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

fn version_identity(version: &str) -> Option<&str> {
    version
        .strip_prefix("v2:")?
        .rsplit_once(':')
        .map(|(identity, _)| identity)
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
        if expected.is_none() {
            if let Some(alternate) = doc.alternate_path.as_deref() {
                let candidate = resolve_path(alternate, workspace)?;
                if opened_identity(&candidate, &authorize).is_ok() {
                    bindings[i].path = Some(alternate.to_owned());
                    continue;
                }
            }
        }
        if let Some(identity) = expected {
            unresolved.entry(identity.to_owned()).or_default().push(i);
        }
    }
    if unresolved.is_empty() {
        return Ok(bindings);
    }
    let started = Instant::now();
    let mut seen = 0usize;
    // A hard-linked file may have several names. Never choose one arbitrarily.
    let mut matches: HashMap<String, Option<String>> = HashMap::new();
    for root in roots {
        let walker = WalkBuilder::new(&root.path)
            .hidden(false)
            .ignore(false)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false)
            .parents(false)
            .follow_links(false)
            .build();
        for entry in walker {
            seen += 1;
            if seen > 100_000 || started.elapsed() > Duration::from_secs(5) {
                return Err("Document reconciliation exceeded its workspace scan limit. Retry after narrowing the workspace.".into());
            }
            let entry = entry.map_err(|e| format!("Could not reconcile workspace: {e}"))?;
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let meta = entry.metadata().map_err(|e| e.to_string())?;
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
        let roots = roots
            .into_iter()
            .map(|display| {
                let path = gates.authorized_existing(&resolve_path(&display, &workspace)?)?;
                if !path.is_dir() {
                    return Err(format!("Reconciliation root is not a folder: {display}"));
                }
                Ok(Root { path, display })
            })
            .collect::<Result<Vec<_>, String>>()?;
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
    fn partial_rename_without_identity_checks_source_before_destination() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::write(&source, "source").unwrap();
        fs::write(&destination, "destination").unwrap();
        let docs = vec![Document {
            id: 1,
            path: source.to_string_lossy().into(),
            version: None,
            alternate_path: Some(destination.to_string_lossy().into()),
        }];
        let roots = vec![Root {
            path: temp.path().into(),
            display: temp.path().to_string_lossy().into(),
        }];
        let find = || reconcile(&docs, &roots, &WorkspaceEnv::default(), |_| Ok(())).unwrap();
        assert_eq!(find()[0].path.as_deref(), source.to_str());
        fs::remove_file(&source).unwrap();
        assert_eq!(find()[0].path.as_deref(), destination.to_str());
        let destination_real = fs::canonicalize(&destination).unwrap();
        let refused = reconcile(&docs, &roots, &WorkspaceEnv::default(), |path| {
            if path == destination_real {
                Err("outside authorized workspace".into())
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(refused[0].path, None);
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
            alternate_path: None,
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
            alternate_path: None,
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
            alternate_path: None,
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
}
