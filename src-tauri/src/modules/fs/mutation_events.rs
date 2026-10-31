//! Ordered entry mutations and window-owned pending recovery destinations.
//! Recovery acquisition and mutation identity capture use the same gate, so
//! aliases and away-and-back renames cannot disappear between IPC responses.
use super::destination::Destination;
use crate::modules::workspace::{resolve_path, Origin, WorkspaceEnv, WorkspaceRegistry};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
};
use tauri::{Emitter, Manager};

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Change {
    Renamed { from: String, to: String },
    Deleted { paths: Vec<String> },
}
impl Change {
    fn paths(&self) -> Vec<&str> {
        match self {
            Self::Renamed { from, to } => vec![from, to],
            Self::Deleted { paths } => paths.iter().map(String::as_str).collect(),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Event {
    pub sequence: u64,
    pub workspace: WorkspaceEnv,
    #[serde(flatten)]
    pub change: Change,
}
struct Recovery {
    owner: String,
    generation: Arc<AtomicBool>,
    workspace: WorkspaceEnv,
    requested: PathBuf,
    target: PathBuf,
    destination: Destination,
    changed: bool,
}
#[derive(Default)]
struct State {
    sequence: u64,
    next: u64,
    recoveries: HashMap<String, Recovery>,
}
#[derive(Default)]
struct Stream(Mutex<State>, Mutex<HashMap<String, Arc<AtomicBool>>>);
fn comparable(path: &Path) -> String {
    let path = super::to_canon(path);
    // Conservative on case-sensitive volumes: an extra interruption is safe.
    #[cfg(any(windows, target_os = "macos"))]
    {
        path.to_lowercase()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        path
    }
}
fn affected(target: &Path, changed: &Path) -> bool {
    let target = comparable(target);
    let changed = comparable(changed);
    target == changed || target.starts_with(&format!("{}/", changed.trim_end_matches('/')))
}
impl Stream {
    #[cfg(test)]
    fn apply<T>(
        &self,
        workspace: WorkspaceEnv,
        mutation: impl FnOnce() -> Result<(T, Option<Change>), String>,
        publish: impl FnOnce(Event),
    ) -> Result<T, String> {
        self.apply_tracked(workspace, HashMap::new, mutation, publish)
    }
    fn apply_tracked<T>(
        &self,
        workspace: WorkspaceEnv,
        resolve: impl FnOnce() -> HashMap<String, PathBuf>,
        mutation: impl FnOnce() -> Result<(T, Option<Change>), String>,
        publish: impl FnOnce(Event),
    ) -> Result<T, String> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // Only recovery needs this additional metadata work, and identity must
        // be captured before deletion/rename makes the old parent unavailable.
        let paths = if !state
            .recoveries
            .values()
            .any(|entry| entry.generation.load(Ordering::Acquire))
        {
            HashMap::new()
        } else {
            resolve()
        };
        let (result, change) = mutation()?;
        if let Some(change) = change {
            let changed_paths = change.paths();
            for recovery in state.recoveries.values_mut().filter(|entry| {
                entry.workspace == workspace && entry.generation.load(Ordering::Acquire)
            }) {
                recovery.changed |= changed_paths.iter().any(|path| {
                    // If preflight could not resolve an entry that did commit,
                    // conservatively invalidate rather than miss its identity.
                    paths
                        .get(*path)
                        .is_none_or(|path| affected(&recovery.target, path))
                });
            }
            state.sequence += 1;
            publish(Event {
                sequence: state.sequence,
                workspace,
                change,
            });
        }
        Ok(result)
    }
    fn epoch(&self, owner: &str) -> Arc<AtomicBool> {
        self.1
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(owner.into())
            .or_insert_with(|| Arc::new(AtomicBool::new(true)))
            .clone()
    }
    fn begin(
        &self,
        owner: String,
        epoch: Arc<AtomicBool>,
        workspace: WorkspaceEnv,
        resolve: impl FnOnce() -> Result<(PathBuf, PathBuf), String>,
    ) -> Result<String, String> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !epoch.load(Ordering::Acquire) {
            return Err("Recovery window was reloaded or closed".into());
        }
        let (requested, target) = resolve()?;
        let destination = Destination::pin(&target, false, &|opened| {
            if opened == target {
                Ok(())
            } else {
                Err("Recovery destination changed".into())
            }
        })
        .map_err(|e| e.to_string())?;
        if !epoch.load(Ordering::Acquire) {
            return Err("Recovery window was reloaded or closed".into());
        }
        state.next += 1;
        let id = state.next.to_string();
        state.recoveries.insert(
            id.clone(),
            Recovery {
                owner,
                generation: epoch,
                workspace,
                requested,
                target,
                destination,
                changed: false,
            },
        );
        Ok(id)
    }
    fn changed(
        &self,
        owner: &str,
        id: &str,
        resolve: impl Fn(&Path) -> Result<PathBuf, String>,
    ) -> Result<bool, String> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let entry = state
            .recoveries
            .get_mut(id)
            .filter(|entry| entry.owner == owner && entry.generation.load(Ordering::Acquire))
            .ok_or("Recovery handle is unavailable")?;
        entry.changed |= entry
            .destination
            .validate(&|opened| {
                if resolve(&entry.requested)? == entry.target && opened == entry.target {
                    Ok(())
                } else {
                    Err("Recovery destination changed".into())
                }
            })
            .is_err();
        Ok(entry.changed || !entry.generation.load(Ordering::Acquire))
    }
    fn end(&self, owner: &str, id: &str) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .recoveries
            .get(id)
            .is_some_and(|entry| entry.owner == owner)
        {
            state.recoveries.remove(id);
        }
    }
    fn release_window(&self, owner: &str) -> bool {
        // This lock never covers filesystem work. Invalidate before returning
        // to the lifecycle/UI thread; slow handle destruction happens elsewhere.
        if let Some(generation) = self
            .1
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(owner)
        {
            generation.store(false, Ordering::Release);
            true
        } else {
            false
        }
    }
    fn cleanup_invalid(&self) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .recoveries
            .retain(|_, entry| entry.generation.load(Ordering::Acquire));
    }
}
static STREAM: LazyLock<Stream> = LazyLock::new(Stream::default);

pub fn release_window(owner: &str) {
    if STREAM.release_window(owner) {
        tauri::async_runtime::spawn_blocking(|| STREAM.cleanup_invalid());
    }
}

#[tauri::command]
pub async fn fs_recovery_begin(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<String, String> {
    let owner = window.label().to_string();
    let epoch = STREAM.epoch(&owner);
    super::blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        STREAM.begin(owner, epoch, workspace.clone(), || {
            let requested = resolve_path(&path, &workspace)?;
            let target = app
                .state::<WorkspaceRegistry>()
                .gates(Origin::App)
                .authorized_write_target(&requested)?;
            Ok((requested, target))
        })
    })
    .await
}
#[tauri::command]
pub async fn fs_recovery_changed(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<bool, String> {
    let owner = window.label().to_string();
    super::blocking(move || {
        STREAM.changed(&owner, &id, |requested| {
            app.state::<WorkspaceRegistry>()
                .gates(Origin::App)
                .authorized_write_target(requested)
        })
    })
    .await
}
#[tauri::command]
pub async fn fs_recovery_end(window: tauri::WebviewWindow, id: String) -> Result<(), String> {
    let owner = window.label().to_owned();
    super::blocking(move || {
        STREAM.end(&owner, &id);
        Ok(())
    })
    .await
}

pub fn transact<T>(
    app: &tauri::AppHandle,
    workspace: WorkspaceEnv,
    requested: &[String],
    mutation: impl FnOnce() -> Result<(T, Option<Change>), String>,
) -> Result<T, String> {
    STREAM.apply_tracked(
        workspace.clone(),
        || {
            requested
                .iter()
                .filter_map(|path| {
                    let resolved = resolve_path(path, &workspace).ok()?;
                    let identity = app
                        .state::<WorkspaceRegistry>()
                        .gates(Origin::App)
                        .authorized_entry(&resolved)
                        .ok()?;
                    Some((path.clone(), identity))
                })
                .collect()
        },
        mutation,
        |event| {
            if let Err(error) = app.emit("fs:mutation", event) {
                log::error!("Could not broadcast committed filesystem mutation: {error}");
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_committed_changes_publish_and_keep_the_owning_environment() {
        let stream = Stream::default();
        let env = WorkspaceEnv::Wsl {
            distro: "Ubuntu".into(),
        };
        let failed: Result<(), String> = stream.apply(
            env.clone(),
            || Err("denied".into()),
            |_| panic!("failed mutation published"),
        );
        assert!(failed.is_err());
        stream
            .apply(
                env.clone(),
                || Ok(((), None)),
                |_| panic!("no-op published"),
            )
            .unwrap();
        stream
            .apply(
                env.clone(),
                || {
                    Ok((
                        (),
                        Some(Change::Deleted {
                            paths: vec!["/work/a".into()],
                        }),
                    ))
                },
                |event| {
                    assert_eq!(event.sequence, 1);
                    assert_eq!(event.workspace, env);
                    let json = serde_json::to_value(event).unwrap();
                    assert_eq!(json["kind"], "deleted");
                    assert_eq!(json["paths"], serde_json::json!(["/work/a"]));
                },
            )
            .unwrap();
    }
    #[test]
    fn concurrent_mutations_publish_in_commit_order() {
        let stream = std::sync::Arc::new(Stream::default());
        let commits = std::sync::Arc::new(Mutex::new(Vec::new()));
        let events = std::sync::Arc::new(Mutex::new(Vec::new()));
        let threads: Vec<_> = (0..8)
            .map(|id| {
                let (stream, commits, events) = (stream.clone(), commits.clone(), events.clone());
                std::thread::spawn(move || {
                    stream
                        .apply(
                            WorkspaceEnv::Local,
                            || {
                                commits.lock().unwrap().push(id);
                                std::thread::yield_now();
                                Ok((
                                    (),
                                    Some(Change::Deleted {
                                        paths: vec![id.to_string()],
                                    }),
                                ))
                            },
                            |event| {
                                let Change::Deleted { paths } = event.change else {
                                    panic!()
                                };
                                events
                                    .lock()
                                    .unwrap()
                                    .push((event.sequence, paths[0].parse::<i32>().unwrap()));
                            },
                        )
                        .unwrap()
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let events = events.lock().unwrap();
        assert_eq!(
            events.iter().map(|e| e.1).collect::<Vec<_>>(),
            *commits.lock().unwrap()
        );
        assert_eq!(
            events.iter().map(|e| e.0).collect::<Vec<_>>(),
            (1..=8).collect::<Vec<_>>()
        );
    }
    fn begin_at(stream: &Stream, owner: &str, path: &Path) -> String {
        let path = path.to_path_buf();
        stream
            .begin(
                owner.into(),
                stream.epoch(owner),
                WorkspaceEnv::Local,
                || {
                    let target = std::fs::canonicalize(path.parent().unwrap())
                        .unwrap()
                        .join(path.file_name().unwrap());
                    Ok((path, target))
                },
            )
            .unwrap()
    }
    fn resolve_entry(path: &Path) -> Result<PathBuf, String> {
        Ok(std::fs::canonicalize(path.parent().unwrap())
            .map_err(|e| e.to_string())?
            .join(path.file_name().unwrap()))
    }
    #[test]
    fn pending_recovery_owns_its_window_and_rejects_late_registration() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("draft");
        let stream = Stream::default();
        let id = begin_at(&stream, "a", &target);
        assert!(!stream.changed("a", &id, resolve_entry).unwrap());
        assert!(stream.changed("b", &id, resolve_entry).is_err());
        stream.end("b", &id);
        assert!(!stream.changed("a", &id, resolve_entry).unwrap());
        let epoch = stream.epoch("a");
        stream.release_window("a");
        assert!(stream.changed("a", &id, resolve_entry).is_err());
        assert!(stream
            .begin("a".into(), epoch, WorkspaceEnv::Local, || panic!(
                "stale acquisition resolved"
            ))
            .is_err());
        stream.cleanup_invalid();
        assert!(stream.0.lock().unwrap().recoveries.is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn native_recovery_tracks_dot_and_symlink_aliases_even_after_move_back() {
        use std::{fs, os::unix::fs::symlink};
        for alias in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = fs::canonicalize(temp.path()).unwrap();
            let real = root.join("real");
            fs::create_dir(&real).unwrap();
            symlink(&real, root.join("alias")).unwrap();
            let file = real.join("draft");
            let moved = real.join("moved");
            let requested = if alias {
                root.join("alias/draft")
            } else {
                real.join("./draft")
            };
            let stream = Stream::default();
            let id = begin_at(&stream, "a", &requested);
            fs::write(&file, b"draft").unwrap();
            let before =
                super::super::document_save::version(&fs::File::open(&file).unwrap(), b"draft")
                    .unwrap();
            for (from, to) in [(&file, &moved), (&moved, &file)] {
                let from_name = from.to_string_lossy().into_owned();
                let to_name = to.to_string_lossy().into_owned();
                stream
                    .apply_tracked(
                        WorkspaceEnv::Local,
                        || {
                            HashMap::from([
                                (from_name.clone(), resolve_entry(from).unwrap()),
                                (to_name.clone(), resolve_entry(to).unwrap()),
                            ])
                        },
                        || {
                            fs::rename(from, to).unwrap();
                            Ok((
                                (),
                                Some(Change::Renamed {
                                    from: from_name.clone(),
                                    to: to_name.clone(),
                                }),
                            ))
                        },
                        |_| {},
                    )
                    .unwrap();
            }
            let after =
                super::super::document_save::version(&fs::File::open(&file).unwrap(), b"draft")
                    .unwrap();
            // Filesystems without birth time conservatively version ctime,
            // which may itself detect rename. Birth-time identities stay equal.
            if fs::metadata(&file).unwrap().created().is_ok() {
                assert_eq!(before, after);
            }
            assert!(stream.changed("a", &id, resolve_entry).unwrap());
            stream.end("a", &id);
            assert!(stream.0.lock().unwrap().recoveries.is_empty());
        }
    }
    #[cfg(unix)]
    #[test]
    fn recovery_directory_pin_rejects_parent_replacement_and_alias_retargeting() {
        use std::{fs, os::unix::fs::symlink};
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let parent = root.join("parent");
        let other = root.join("other");
        fs::create_dir(&parent).unwrap();
        fs::create_dir(&other).unwrap();
        symlink(&parent, root.join("alias")).unwrap();
        let stream = Stream::default();
        let alias = begin_at(&stream, "a", &root.join("alias/draft"));
        fs::remove_file(root.join("alias")).unwrap();
        symlink(&other, root.join("alias")).unwrap();
        assert!(stream.changed("a", &alias, resolve_entry).unwrap());
        let direct = begin_at(&stream, "a", &parent.join("draft"));
        fs::rename(&parent, root.join("old")).unwrap();
        fs::create_dir(&parent).unwrap();
        assert!(stream.changed("a", &direct, resolve_entry).unwrap());
    }
    #[test]
    fn failed_and_unrelated_mutations_do_not_interrupt_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let stream = Stream::default();
        let id = begin_at(&stream, "a", &root.join("draft"));
        let failed: Result<(), String> = stream.apply_tracked(
            WorkspaceEnv::Local,
            || HashMap::from([("x".into(), root.clone())]),
            || Err("denied".into()),
            |_| panic!(),
        );
        assert!(failed.is_err());
        stream
            .apply_tracked(
                WorkspaceEnv::Local,
                || HashMap::from([("x".into(), root.join("unrelated"))]),
                || {
                    Ok((
                        (),
                        Some(Change::Deleted {
                            paths: vec!["x".into()],
                        }),
                    ))
                },
                |_| {},
            )
            .unwrap();
        stream
            .apply_tracked(
                WorkspaceEnv::Wsl {
                    distro: "Ubuntu".into(),
                },
                HashMap::new,
                || {
                    Ok((
                        (),
                        Some(Change::Deleted {
                            paths: vec!["x".into()],
                        }),
                    ))
                },
                |_| {},
            )
            .unwrap();
        assert!(!stream.changed("a", &id, resolve_entry).unwrap());
        stream
            .apply_tracked(
                WorkspaceEnv::Local,
                || HashMap::from([("x".into(), root.clone())]),
                || {
                    Ok((
                        (),
                        Some(Change::Deleted {
                            paths: vec!["x".into()],
                        }),
                    ))
                },
                |_| {},
            )
            .unwrap();
        assert!(stream.changed("a", &id, resolve_entry).unwrap());
    }
    #[test]
    fn window_cleanup_does_not_wait_for_unrelated_filesystem_io() {
        use std::{
            sync::{mpsc, Arc},
            time::Duration,
        };
        let stream = Arc::new(Stream::default());
        let (entered, started) = mpsc::channel();
        let (release, continue_io) = mpsc::channel();
        let worker = {
            let stream = stream.clone();
            std::thread::spawn(move || {
                stream
                    .apply(
                        WorkspaceEnv::Local,
                        || {
                            entered.send(()).unwrap();
                            continue_io.recv().unwrap();
                            Ok(((), None))
                        },
                        |_| {},
                    )
                    .unwrap();
            })
        };
        started.recv().unwrap();
        let (cleanup_started, observed_start) = mpsc::channel();
        let (finished, observed_finish) = mpsc::channel();
        let cleanup = std::thread::spawn(move || {
            cleanup_started.send(()).unwrap();
            stream.release_window("closing-window");
            finished.send(()).unwrap();
        });
        observed_start.recv().unwrap();
        let responsive = observed_finish
            .recv_timeout(Duration::from_millis(100))
            .is_ok();
        release.send(()).unwrap();
        worker.join().unwrap();
        cleanup.join().unwrap();
        assert!(
            responsive,
            "window cleanup blocked behind another filesystem operation"
        );
    }
    #[test]
    fn delayed_cleanup_keeps_replacement_page_handles() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let stream = Stream::default();
        let begin = |epoch| {
            stream
                .begin("a".into(), epoch, WorkspaceEnv::Local, || {
                    Ok((root.join("file"), root.join("file")))
                })
                .unwrap()
        };
        let old = begin(stream.epoch("a"));
        stream.release_window("a");
        let new = begin(stream.epoch("a"));
        stream.cleanup_invalid();
        assert!(stream.changed("a", &old, resolve_entry).is_err());
        assert!(!stream.changed("a", &new, resolve_entry).unwrap());
    }
    #[test]
    fn release_during_slow_acquisition_rejects_the_late_handle() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().canonicalize().unwrap().join("file");
        let stream = Arc::new(Stream::default());
        let epoch = stream.epoch("a");
        let (entered, started) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let worker = {
            let stream = stream.clone();
            std::thread::spawn(move || {
                stream.begin("a".into(), epoch, WorkspaceEnv::Local, || {
                    entered.send(()).unwrap();
                    wait.recv().unwrap();
                    Ok((target.clone(), target))
                })
            })
        };
        started.recv().unwrap();
        stream.release_window("a");
        release.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
        assert!(stream.0.lock().unwrap().recoveries.is_empty());
    }
    #[test]
    fn release_during_validation_never_returns_an_unchanged_handle() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().canonicalize().unwrap().join("file");
        let stream = Stream::default();
        let id = stream
            .begin("a".into(), stream.epoch("a"), WorkspaceEnv::Local, || {
                Ok((target.clone(), target.clone()))
            })
            .unwrap();
        assert!(stream
            .changed("a", &id, |_| {
                stream.release_window("a");
                Ok(target.clone())
            })
            .unwrap());
    }
}
