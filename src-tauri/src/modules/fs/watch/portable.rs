//! inotify (Linux) and ReadDirectoryChangesW (Windows) backend via notify.
//! Both are real non-recursive per-directory watches, so only the directories
//! the frontend asked for are registered.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::plan::{self, Batch, WatchSet};
use super::{Backend, Sink};
use crate::modules::fs::to_canon;

pub struct Notify {
    sink: Sink,
    error: Arc<Mutex<Option<String>>>,
    watcher: RecommendedWatcher,
    watched: HashSet<PathBuf>,
}

impl Notify {
    pub fn new(sink: Sink) -> Result<Self, String> {
        let error = Arc::new(Mutex::new(None));
        let callback_error = error.clone();
        let owner_sink = sink.clone();
        let watcher = RecommendedWatcher::new(
            move |result: notify::Result<Event>| {
                let event = match result {
                    Ok(event) => event,
                    Err(error) => {
                        let error = format!("File notifications failed: {error}");
                        let mut shared_error =
                            callback_error.lock().unwrap_or_else(|e| e.into_inner());
                        *shared_error = Some(error.clone());
                        sink.failed(error);
                        return;
                    }
                };
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                // Runs on notify's event thread, which a panic would end for good.
                crate::modules::panics::isolate("fs watch event", || {
                    let dirs = sink.dirs();
                    let mut batch = Batch::default();
                    for path in &event.paths {
                        if let Some(dir) = plan::owning_dir(&to_canon(path), &dirs) {
                            if !batch.dirs.contains(&dir) {
                                batch.dirs.push(dir);
                            }
                        }
                    }
                    sink.send(batch);
                });
            },
            Config::default(),
        )
        .map_err(|e| e.to_string())?;
        Ok(Self {
            sink: owner_sink,
            error,
            watcher,
            watched: HashSet::new(),
        })
    }
}

impl Backend for Notify {
    fn publishes_health(&self) -> bool {
        true
    }
    fn health_error(&self) -> Option<String> {
        self.error.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn sync(&mut self, set: &WatchSet) {
        let previous_error = self.error.lock().unwrap_or_else(|e| e.into_inner()).take();
        let mut registration_error = None;
        if previous_error.is_some() {
            for dir in self.watched.drain() {
                let _ = self.watcher.unwatch(&dir);
            }
        }
        let wanted: HashSet<PathBuf> = set
            .dir_paths()
            .filter(|p| !plan::is_wsl_share(&to_canon(p)))
            .map(PathBuf::from)
            .collect();
        for gone in self.watched.difference(&wanted) {
            let _ = self.watcher.unwatch(gone);
        }
        let mut live = HashSet::with_capacity(wanted.len());
        for dir in wanted {
            if self.watched.contains(&dir) {
                live.insert(dir);
                continue;
            }
            match self.watcher.watch(&dir, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    live.insert(dir);
                }
                Err(e) => {
                    registration_error = Some(format!("Cannot watch {}: {e}", dir.display()));
                }
            }
        }
        self.watched = live;
        // Do not hold this lock across notify's synchronous registration calls:
        // its callback may be waiting to report a runtime failure.
        let mut error = self.error.lock().unwrap_or_else(|e| e.into_inner());
        if registration_error.is_some() {
            *error = registration_error;
        }
        self.sink.coverage(error.clone());
    }
}
