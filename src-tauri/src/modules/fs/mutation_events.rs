//! Ordered entry mutations.
//! Mutations that touch the same paths (or a path and its ancestor) run one at a
//! time, from claim to publish, so they commit and publish in the same order;
//! unrelated ones run side by side. The stream lock is held only to claim, to
//! record and to publish, never across filesystem work, so deleting a large
//! folder in one window stalls nothing else.
use crate::modules::workspace::{resolve_path, WorkspaceEnv};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{Condvar, LazyLock, Mutex},
};
use tauri::Emitter;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Change {
    Renamed { from: String, to: String },
    Deleted { paths: Vec<String> },
    /// Git is about to rewrite `roots` (canonical entry names) in `repo_root`.
    #[serde(rename = "discard-begin", rename_all = "camelCase")]
    DiscardBegin {
        id: u64,
        origin: String,
        repo_root: String,
        roots: Vec<String>,
    },
    #[serde(rename = "discard-end")]
    DiscardEnd { id: u64, ok: bool },
}
pub struct Discarding {
    pub origin: String,
    pub repo_root: String,
    pub roots: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Event {
    pub sequence: u64,
    pub workspace: WorkspaceEnv,
    #[serde(flatten)]
    pub change: Change,
}
#[derive(Default)]
struct State {
    sequence: u64,
    claims: Vec<(u64, Vec<String>)>,
    next_claim: u64,
    emit_failures: u64,
}
#[derive(Default)]
struct Stream(Mutex<State>, Condvar);

/// Paths a running operation owns until it has published; dropped on every exit.
struct Claim<'a> {
    stream: &'a Stream,
    id: u64,
}
impl Drop for Claim<'_> {
    fn drop(&mut self) {
        let mut state = self.stream.0.lock().unwrap_or_else(|e| e.into_inner());
        state.claims.retain(|(id, _)| *id != self.id);
        self.stream.1.notify_all();
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
            state = self.1.wait(state).unwrap_or_else(|e| e.into_inner());
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
            mutation,
            publish,
        )
    }
    fn sequence(&self) -> u64 {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).sequence
    }
    /// Publishes under the state lock so `sequence()` taken afterwards, by a read
    /// that saw what the announced work wrote, is never below the event's.
    fn announce(
        &self,
        workspace: &WorkspaceEnv,
        change: impl FnOnce(u64) -> Change,
        publish: &impl Fn(Event) -> Result<(), String>,
    ) -> u64 {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.sequence += 1;
        let sequence = state.sequence;
        let event = Event {
            sequence,
            workspace: workspace.clone(),
            change: change(sequence),
        };
        if let Err(error) = publish(event) {
            state.emit_failures += 1;
            log::error!("Could not broadcast filesystem event: {error}");
        }
        sequence
    }
    /// Announces a discard, runs it, and always announces its end. The claim keeps
    /// Oarlock's own renames and deletes of the same paths ordered around it.
    fn bracket<T>(
        &self,
        workspace: WorkspaceEnv,
        claims: &[PathBuf],
        discarding: Discarding,
        run: impl FnOnce() -> Result<T, String>,
        publish: impl Fn(Event) -> Result<(), String>,
    ) -> Result<T, String> {
        struct Ending<'a, P: Fn(Event) -> Result<(), String>> {
            stream: &'a Stream,
            workspace: &'a WorkspaceEnv,
            publish: &'a P,
            id: u64,
            ok: bool,
        }
        impl<P: Fn(Event) -> Result<(), String>> Drop for Ending<'_, P> {
            fn drop(&mut self) {
                let (id, ok) = (self.id, self.ok);
                self.stream
                    .announce(self.workspace, |_| Change::DiscardEnd { id, ok }, self.publish);
            }
        }
        let _claim = self.claim(claims);
        let id = self.announce(
            &workspace,
            |id| Change::DiscardBegin {
                id,
                origin: discarding.origin,
                repo_root: discarding.repo_root,
                roots: discarding.roots,
            },
            &publish,
        );
        let mut ending = Ending {
            stream: self,
            workspace: &workspace,
            publish: &publish,
            id,
            ok: false,
        };
        let result = run();
        ending.ok = result.is_ok();
        result
    }
    fn apply_tracked<T>(
        &self,
        workspace: WorkspaceEnv,
        claims: &[PathBuf],
        mutation: impl FnOnce() -> Result<(T, Option<Change>), String>,
        publish: impl FnOnce(Event) -> Result<(), String>,
    ) -> Result<T, String> {
        let _claim = self.claim(claims);
        let (result, change) = mutation()?;
        if let Some(change) = change {
            let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
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
}
static STREAM: LazyLock<Stream> = LazyLock::new(Stream::default);

/// The stream's current sequence: what a window without a live listener starts from.
pub fn sequence() -> u64 {
    STREAM.sequence()
}
#[tauri::command]
pub async fn fs_mutation_sequence() -> u64 {
    sequence()
}

pub fn discard_bracket<T>(
    app: &tauri::AppHandle,
    workspace: WorkspaceEnv,
    claims: &[PathBuf],
    discarding: Discarding,
    run: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    STREAM.bracket(workspace, claims, discarding, run, |event| {
        app.emit("fs:mutation", event).map_err(|error| error.to_string())
    })
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
        mutation,
        |event| app.emit("fs:mutation", event).map_err(|error| error.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
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

    #[test]
    fn discard_events_keep_the_wire_names_the_pages_listen_for() {
        let begin = serde_json::to_value(Event {
            sequence: 4,
            workspace: WorkspaceEnv::Local,
            change: Change::DiscardBegin {
                id: 4,
                origin: "main".into(),
                repo_root: "/repo".into(),
                roots: vec!["/repo/f".into()],
            },
        })
        .unwrap();
        assert_eq!(begin["kind"], "discard-begin");
        assert_eq!(begin["repoRoot"], "/repo");
        assert_eq!(begin["roots"], serde_json::json!(["/repo/f"]));
        let end = serde_json::to_value(Change::DiscardEnd { id: 4, ok: true }).unwrap();
        assert_eq!(end["kind"], "discard-end");
    }
    type Seen = Arc<Mutex<Vec<Event>>>;
    fn discarding() -> Discarding {
        Discarding {
            origin: "main".into(),
            repo_root: "/repo".into(),
            roots: vec!["/repo/file".into()],
        }
    }
    fn collect() -> (Seen, impl Fn(Event) -> Result<(), String>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        (seen, move |event| {
            sink.lock().unwrap().push(event);
            Ok(())
        })
    }
    #[test]
    fn discard_publishes_begin_before_and_end_after_the_run_even_when_it_fails() {
        for outcome in [Ok(()), Err("git failed".to_string()), Err("panic".into())] {
            let stream = Stream::default();
            let (seen, publish) = collect();
            let during = seen.clone();
            let panics = outcome == Err("panic".to_string());
            let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                stream.bracket(
                    WorkspaceEnv::Local,
                    &[PathBuf::from("/repo/file")],
                    discarding(),
                    || {
                        {
                            let events = during.lock().unwrap();
                            assert!(matches!(
                                events.as_slice(),
                                [Event { change: Change::DiscardBegin { .. }, .. }]
                            ));
                            assert_eq!(stream.sequence(), events[0].sequence);
                        }
                        if panics {
                            panic!("boom");
                        }
                        outcome.clone()
                    },
                    &publish,
                )
            }));
            let events = seen.lock().unwrap();
            assert_eq!(events.len(), 2);
            let (Change::DiscardBegin { id, roots, .. }, Change::DiscardEnd { id: end, ok }) =
                (&events[0].change, &events[1].change)
            else {
                panic!("expected begin then end")
            };
            assert_eq!((*id, *end), (events[0].sequence, events[0].sequence));
            assert_eq!(roots, &vec!["/repo/file".to_string()]);
            assert_eq!(*ok, matches!(attempt, Ok(Ok(()))));
        }
    }
    #[test]
    fn a_discard_claims_its_roots_so_a_rename_inside_waits() {
        use std::sync::mpsc;
        use std::time::Duration;
        let stream = Arc::new(Stream::default());
        let (entered, started) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let discard = {
            let stream = stream.clone();
            std::thread::spawn(move || {
                let (_, publish) = collect();
                stream
                    .bracket(
                        WorkspaceEnv::Local,
                        &[PathBuf::from("/repo/dir")],
                        discarding(),
                        || {
                            entered.send(()).unwrap();
                            held.recv().unwrap();
                            Ok(())
                        },
                        publish,
                    )
                    .unwrap();
            })
        };
        started.recv().unwrap();
        let (ran, observed) = mpsc::channel();
        let rename = {
            let stream = stream.clone();
            std::thread::spawn(move || {
                stream
                    .apply_tracked(
                        WorkspaceEnv::Local,
                        &[PathBuf::from("/repo/dir/inner")],
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
        discard.join().unwrap();
        rename.join().unwrap();
    }
}
