//! Ordered entry mutations and window-owned pending recovery destinations.
//! Mutations that touch the same paths (or a path and its ancestor) run one at a
//! time, from claim to publish, so they commit and publish in the same order;
//! unrelated ones run side by side. The stream lock is held only to claim, to
//! record and to publish, never across filesystem work, so deleting a large
//! folder in one window stalls nothing else. Recovery acquisition claims its
//! target the same way, so aliases and away-and-back renames cannot slip
//! between IPC responses.
use super::destination::Destination;
use crate::modules::workspace::{resolve_path, Origin, WorkspaceEnv, WorkspaceRegistry};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, LazyLock, Mutex,
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
    claims: Vec<(u64, Vec<String>)>,
    next_claim: u64,
    emit_failures: u64,
}
#[derive(Default)]
struct Stream(
    Mutex<State>,
    Mutex<HashMap<String, Arc<AtomicBool>>>,
    Condvar,
);

/// Paths a running operation owns until it has published; dropped on every exit.
struct Claim<'a> {
    stream: &'a Stream,
    id: u64,
}
impl Drop for Claim<'_> {
    fn drop(&mut self) {
        let mut state = self.stream.0.lock().unwrap_or_else(|e| e.into_inner());
        state.claims.retain(|(id, _)| *id != self.id);
        self.stream.2.notify_all();
    }
}
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
fn under(child: &str, parent: &str) -> bool {
    child.starts_with(&format!("{}/", parent.trim_end_matches('/')))
}
fn overlaps(a: &str, b: &str) -> bool {
    a == b || under(a, b) || under(b, a)
}
/// The entry a request names, spelled through its resolved parent when that exists.
fn claim_path(path: &Path) -> PathBuf {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => std::fs::canonicalize(parent)
            .map(|parent| parent.join(name))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    }
}
impl Stream {
    /// Waits until no running operation owns an overlapping path, then owns them.
    fn claim(&self, paths: &[PathBuf]) -> Claim<'_> {
        let paths: Vec<String> = paths.iter().map(|path| comparable(path)).collect();
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        while state.claims.iter().any(|(_, held)| {
            held.iter()
                .any(|held| paths.iter().any(|wanted| overlaps(held, wanted)))
        }) {
            state = self.2.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        state.next_claim += 1;
        let id = state.next_claim;
        state.claims.push((id, paths));
        Claim { stream: self, id }
    }
    #[cfg(test)]
    fn apply<T>(
        &self,
        workspace: WorkspaceEnv,
        mutation: impl FnOnce() -> Result<(T, Option<Change>), String>,
        publish: impl FnOnce(Event) -> Result<(), String>,
    ) -> Result<T, String> {
        // The root overlaps every path, so these run strictly one at a time.
        self.apply_tracked(
            workspace,
            &[PathBuf::from("/")],
            HashMap::new,
            mutation,
            publish,
        )
    }
    fn apply_tracked<T>(
        &self,
        workspace: WorkspaceEnv,
        claims: &[PathBuf],
        resolve: impl FnOnce() -> HashMap<String, PathBuf>,
        mutation: impl FnOnce() -> Result<(T, Option<Change>), String>,
        publish: impl FnOnce(Event) -> Result<(), String>,
    ) -> Result<T, String> {
        let _claim = self.claim(claims);
        // Only recovery needs this additional metadata work, and identity must
        // be captured before deletion/rename makes the old parent unavailable.
        // Recoveries registered later cannot overlap this claim (their `begin`
        // would have waited for it), so only these are judged at publish.
        let existing: Vec<String> = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .recoveries
            .iter()
            .filter(|(_, entry)| entry.generation.load(Ordering::Acquire))
            .map(|(id, _)| id.clone())
            .collect();
        let paths = if existing.is_empty() { HashMap::new() } else { resolve() };
        let (result, change) = mutation()?;
        if let Some(change) = change {
            let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
            let changed_paths = change.paths();
            for recovery in state
                .recoveries
                .iter_mut()
                .filter(|(id, entry)| {
                    existing.contains(*id)
                        && entry.workspace == workspace
                        && entry.generation.load(Ordering::Acquire)
                })
                .map(|(_, entry)| entry)
            {
                recovery.changed |= changed_paths.iter().any(|path| {
                    // If preflight could not resolve an entry that did commit,
                    // conservatively invalidate rather than miss its identity.
                    paths
                        .get(*path)
                        .is_none_or(|path| affected(&recovery.target, path))
                });
            }
            // The sequence advances even when delivery fails, so a window that
            // missed the event sees a gap and reconciles instead of trusting it.
            state.sequence += 1;
            if let Err(error) = publish(Event {
                sequence: state.sequence,
                workspace,
                change,
            }) {
                state.emit_failures += 1;
                log::error!("Could not broadcast committed filesystem mutation: {error}");
            }
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
        if !epoch.load(Ordering::Acquire) {
            return Err("Recovery window was reloaded or closed".into());
        }
        let (requested, target) = resolve()?;
        // Owning the target until the record exists keeps a mutation from
        // committing between the pin and the registration unseen.
        let _claim = self.claim(std::slice::from_ref(&target));
        let destination = Destination::pin(&target, false, &|opened| {
            if opened == target {
                Ok(())
            } else {
                Err("Recovery destination changed".into())
            }
        })
        .map_err(|e| e.to_string())?;
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
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
    let claims: Vec<PathBuf> = requested
        .iter()
        .map(|path| match resolve_path(path, &workspace) {
            Ok(resolved) => claim_path(&resolved),
            Err(_) => PathBuf::from(path),
        })
        .collect();
    STREAM.apply_tracked(
        workspace.clone(),
        &claims,
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
        |event| app.emit("fs:mutation", event).map_err(|error| error.to_string()),
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
                    Ok(())
                },
            )
            .unwrap();
    }
    #[test]
    fn a_running_mutation_does_not_hold_the_stream_lock() {
        let stream = Stream::default();
        stream
            .apply(
                WorkspaceEnv::Local,
                || {
                    assert!(
                        stream.0.try_lock().is_ok(),
                        "the stream lock is held across the filesystem mutation"
                    );
                    Ok(((), None))
                },
                |_| unreachable!(),
            )
            .unwrap();
    }

    #[test]
    fn unrelated_mutations_overlap_while_related_ones_wait_their_turn() {
        use std::sync::mpsc;
        use std::time::Duration;
        let stream = Arc::new(Stream::default());
        let (entered, started) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let slow = {
            let stream = stream.clone();
            std::thread::spawn(move || {
                stream
                    .apply_tracked(
                        WorkspaceEnv::Local,
                        &[PathBuf::from("/work/big")],
                        HashMap::new,
                        || {
                            entered.send(()).unwrap();
                            held.recv().unwrap();
                            Ok(((), None))
                        },
                        |_| Ok(()),
                    )
                    .unwrap();
            })
        };
        started.recv().unwrap();
        // A different folder is not delayed by the slow delete above. It runs on
        // a thread so a broken claim fails the test instead of hanging it.
        let (done, finished) = mpsc::channel();
        let other = {
            let stream = stream.clone();
            std::thread::spawn(move || {
                let result = stream.apply_tracked(
                    WorkspaceEnv::Local,
                    &[PathBuf::from("/work/other")],
                    HashMap::new,
                    || Ok((7, None)),
                    |_| Ok(()),
                );
                done.send(result).unwrap();
            })
        };
        let unrelated = finished.recv_timeout(Duration::from_secs(2));
        if unrelated.is_err() {
            release.send(()).unwrap();
        }
        assert_eq!(unrelated.expect("an unrelated mutation waited").unwrap(), 7);
        other.join().unwrap();
        // Something inside the folder being removed waits for it.
        let (ran, observed) = mpsc::channel();
        let nested = {
            let stream = stream.clone();
            std::thread::spawn(move || {
                stream
                    .apply_tracked(
                        WorkspaceEnv::Local,
                        &[PathBuf::from("/work/big/inner")],
                        HashMap::new,
                        || {
                            ran.send(()).unwrap();
                            Ok(((), None))
                        },
                        |_| Ok(()),
                    )
                    .unwrap();
            })
        };
        assert!(observed.recv_timeout(Duration::from_millis(150)).is_err());
        release.send(()).unwrap();
        observed.recv_timeout(Duration::from_secs(5)).unwrap();
        slow.join().unwrap();
        nested.join().unwrap();
    }
    #[test]
    fn a_failed_broadcast_is_counted_and_leaves_a_visible_sequence_gap() {
        let stream = Stream::default();
        let change = || {
            Some(Change::Deleted {
                paths: vec!["/work/a".into()],
            })
        };
        stream
            .apply(WorkspaceEnv::Local, || Ok(((), change())), |_| {
                Err("no window".into())
            })
            .unwrap();
        assert_eq!(stream.0.lock().unwrap().emit_failures, 1);
        let mut seen = 0;
        stream
            .apply(WorkspaceEnv::Local, || Ok(((), change())), |event| {
                seen = event.sequence;
                Ok(())
            })
            .unwrap();
        assert_eq!(seen, 2, "the lost event must be visible as a gap");
    }
    #[test]
    fn an_unrelated_mutation_does_not_invalidate_a_recovery_registered_meanwhile() {
        use std::sync::mpsc;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let stream = Arc::new(Stream::default());
        let (entered, started) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let mutation = {
            let stream = stream.clone();
            std::thread::spawn(move || {
                stream
                    .apply_tracked(
                        WorkspaceEnv::Local,
                        &[PathBuf::from("/elsewhere/node_modules")],
                        HashMap::new,
                        || {
                            entered.send(()).unwrap();
                            held.recv().unwrap();
                            Ok((
                                (),
                                Some(Change::Deleted {
                                    paths: vec!["/elsewhere/node_modules".into()],
                                }),
                            ))
                        },
                        |_| Ok(()),
                    )
                    .unwrap();
            })
        };
        started.recv().unwrap();
        let id = begin_at(&stream, "a", &root.join("draft"));
        release.send(()).unwrap();
        mutation.join().unwrap();
        let changed = stream.0.lock().unwrap().recoveries.get(&id).unwrap().changed;
        assert!(!changed, "an unrelated delete invalidated a concurrent recovery");
    }
    #[test]
    fn a_recovery_waits_for_a_running_mutation_of_its_target() {
        use std::sync::mpsc;
        use std::time::Duration;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let target = root.join("draft");
        let stream = Arc::new(Stream::default());
        let (entered, started) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let mutation = {
            let (stream, target) = (stream.clone(), target.clone());
            std::thread::spawn(move || {
                stream
                    .apply_tracked(
                        WorkspaceEnv::Local,
                        &[target],
                        HashMap::new,
                        || {
                            entered.send(()).unwrap();
                            held.recv().unwrap();
                            Ok(((), None))
                        },
                        |_| Ok(()),
                    )
                    .unwrap();
            })
        };
        started.recv().unwrap();
        let (registered, observed) = mpsc::channel();
        let begin = {
            let (stream, target) = (stream.clone(), target.clone());
            std::thread::spawn(move || {
                let id = begin_at(&stream, "a", &target);
                registered.send(()).unwrap();
                id
            })
        };
        assert!(observed.recv_timeout(Duration::from_millis(150)).is_err());
        release.send(()).unwrap();
        observed.recv_timeout(Duration::from_secs(5)).unwrap();
        mutation.join().unwrap();
        begin.join().unwrap();
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
                                Ok(())
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
                        &[from.clone(), to.clone()],
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
                        |_| Ok(()),
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
            std::slice::from_ref(&root),
            || HashMap::from([("x".into(), root.clone())]),
            || Err("denied".into()),
            |_| panic!(),
        );
        assert!(failed.is_err());
        stream
            .apply_tracked(
                WorkspaceEnv::Local,
                std::slice::from_ref(&root),
                || HashMap::from([("x".into(), root.join("unrelated"))]),
                || {
                    Ok((
                        (),
                        Some(Change::Deleted {
                            paths: vec!["x".into()],
                        }),
                    ))
                },
                |_| Ok(()),
            )
            .unwrap();
        stream
            .apply_tracked(
                WorkspaceEnv::Wsl {
                    distro: "Ubuntu".into(),
                },
                std::slice::from_ref(&root),
                HashMap::new,
                || {
                    Ok((
                        (),
                        Some(Change::Deleted {
                            paths: vec!["x".into()],
                        }),
                    ))
                },
                |_| Ok(()),
            )
            .unwrap();
        assert!(!stream.changed("a", &id, resolve_entry).unwrap());
        stream
            .apply_tracked(
                WorkspaceEnv::Local,
                std::slice::from_ref(&root),
                || HashMap::from([("x".into(), root.clone())]),
                || {
                    Ok((
                        (),
                        Some(Change::Deleted {
                            paths: vec!["x".into()],
                        }),
                    ))
                },
                |_| Ok(()),
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
                        |_| Ok(()),
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
