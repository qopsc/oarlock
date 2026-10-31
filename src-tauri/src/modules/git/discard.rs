//! Cross-window editor preparation for Discard. The state lock never covers
//! filesystem work, event delivery or waiting on a webview.
use super::{operations, types::DiscardEntry, utils};
use crate::modules::{
    windows::is_app_window,
    workspace::{resolve_path, Origin, WorkspaceEnv, WorkspaceRegistry},
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

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
#[derive(Clone, Serialize)]
struct Scope {
    paths: Vec<String>,
    workspace: WorkspaceEnv,
}
#[derive(Clone, Serialize)]
struct Event {
    id: String,
    token: String,
    nonce: String,
    owner: bool,
    phase: &'static str,
    #[serde(flatten)]
    scope: Scope,
}
#[derive(Clone, Serialize)]
pub struct Status {
    phase: &'static str,
    ok: bool,
}
struct Round {
    id: String,
    owner: String,
    owner_token: String,
    nonce: String,
    scope: Scope,
    work: Option<Work>,
    phase: &'static str,
    ok: bool,
    members: HashMap<String, String>,
    waiting: HashSet<String>,
}
impl Round {
    fn event(&self, label: &str, token: &str, phase: &'static str) -> Event {
        Event {
            id: self.id.clone(),
            token: token.into(),
            nonce: self.nonce.clone(),
            owner: label == self.owner && token == self.owner_token,
            phase,
            scope: self.scope.clone(),
        }
    }
    fn events(&self, phase: &'static str) -> Vec<(String, Event)> {
        self.members
            .iter()
            .filter(|(_, token)| !token.is_empty())
            .map(|(label, token)| (label.clone(), self.event(label, token, phase)))
            .collect()
    }
}
#[derive(Default)]
struct State {
    next: u64,
    clients: HashMap<String, String>,
    active: Option<Round>,
}
impl State {
    fn register(&mut self, label: &str) -> (String, Vec<(String, Event)>) {
        let mut events = if self.active.as_ref().is_some_and(|r| r.phase == "preparing") {
            self.release(label)
        } else {
            vec![]
        };
        self.next += 1;
        let token = self.next.to_string();
        self.clients.insert(label.into(), token.clone());
        if let Some(round) = &mut self.active {
            round.members.insert(label.into(), token.clone());
            events.push((label.into(), round.event(label, &token, "prepare")));
            if round.phase == "finished" {
                events.push((
                    label.into(),
                    round.event(label, &token, if round.ok { "complete" } else { "cancel" }),
                ));
            }
        }
        (token, events)
    }
    fn finish(&mut self, id: &str, ok: bool) -> Vec<(String, Event)> {
        let Some(round) = self
            .active
            .as_mut()
            .filter(|r| r.id == id && r.phase != "finished")
        else {
            return vec![];
        };
        round.phase = "finished";
        round.ok = ok;
        round.work = None;
        round.waiting.clear();
        let events = round.events(if ok { "complete" } else { "cancel" });
        if round.members.is_empty() {
            self.active = None;
        }
        events
    }
    fn release(&mut self, label: &str) -> Vec<(String, Event)> {
        self.clients.remove(label);
        let Some(round) = &mut self.active else {
            return vec![];
        };
        round.members.remove(label);
        round.waiting.remove(label);
        if round.phase == "preparing" {
            let id = round.id.clone();
            return self.finish(&id, false);
        }
        if round.phase == "finished" && round.members.is_empty() {
            self.active = None;
        }
        vec![]
    }
    fn loading(&mut self, label: &str) -> Vec<(String, Event)> {
        self.clients.remove(label);
        let Some(round) = &mut self.active else {
            return vec![];
        };
        // Retain the result for a page still booting, even if the worker and
        // every old participant finish before its registration arrives.
        round.members.insert(label.into(), String::new());
        round.waiting.remove(label);
        if round.phase == "preparing" {
            let id = round.id.clone();
            self.finish(&id, false)
        } else {
            vec![]
        }
    }
    fn begin(
        &mut self,
        owner: &str,
        token: &str,
        nonce: String,
        windows: Vec<String>,
        scope: Scope,
        work: Work,
    ) -> Result<(String, Vec<(String, Event)>), String> {
        if self.clients.get(owner).map(String::as_str) != Some(token) {
            return Err("Document coordination is not ready. Retry synchronization.".into());
        }
        if self.active.is_some() {
            return Err(
                "Another Discard is still being synchronized. Try again when it finishes.".into(),
            );
        }
        if windows.is_empty()
            || !windows.iter().any(|label| label == owner)
            || windows
                .iter()
                .any(|label| !self.clients.contains_key(label))
        {
            return Err(
                "An editor window is still loading or unavailable. Discard was not started.".into(),
            );
        }
        self.next += 1;
        let id = self.next.to_string();
        let members = windows
            .iter()
            .map(|label| (label.clone(), self.clients[label].clone()))
            .collect();
        let round = Round {
            id: id.clone(),
            owner: owner.into(),
            owner_token: token.into(),
            nonce,
            scope,
            work: Some(work),
            phase: "preparing",
            ok: false,
            members,
            waiting: windows.into_iter().collect(),
        };
        let events = round.events("prepare");
        self.active = Some(round);
        Ok((id, events))
    }
    fn prepared(&mut self, label: &str, token: &str, id: &str, ok: bool) -> Vec<(String, Event)> {
        let Some(round) = self
            .active
            .as_mut()
            .filter(|r| r.id == id && r.members.get(label).map(String::as_str) == Some(token))
        else {
            return vec![];
        };
        if round.phase == "preparing" {
            if !ok {
                return self.finish(id, false);
            }
            round.waiting.remove(label);
        }
        vec![]
    }
    fn take_work(&mut self, owner: &str, token: &str, id: &str) -> Result<Option<Work>, String> {
        let round = self
            .active
            .as_mut()
            .filter(|r| r.id == id && r.owner == owner && r.owner_token == token)
            .ok_or("Discard request expired")?;
        if round.phase != "preparing" {
            return Err("Discard was cancelled or has already started".into());
        }
        if !round.waiting.is_empty() {
            return Ok(None);
        }
        round.phase = "running";
        Ok(round.work.take())
    }
    fn status(&self, label: &str, token: &str, id: &str) -> Result<Status, String> {
        if self.clients.get(label).map(String::as_str) != Some(token) {
            return Err("Document coordinator was replaced".into());
        }
        let Some(round) = self
            .active
            .as_ref()
            .filter(|r| r.id == id && r.members.get(label).map(String::as_str) == Some(token))
        else {
            return Ok(Status {
                phase: "gone",
                ok: false,
            });
        };
        Ok(Status {
            phase: round.phase,
            ok: round.ok,
        })
    }
    fn settled(&mut self, label: &str, token: &str, id: &str) {
        if let Some(round) = self.active.as_mut().filter(|r| {
            r.id == id
                && r.phase == "finished"
                && r.members.get(label).map(String::as_str) == Some(token)
        }) {
            round.members.remove(label);
            if round.members.is_empty() {
                self.active = None;
            }
        }
    }
}
static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State::default()));
static CHANGED: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);
fn publish(app: &AppHandle, events: Vec<(String, Event)>) {
    for (label, event) in events {
        if let Err(error) = app.emit_to(&label, "git:discard", &event) {
            log::warn!("Could not deliver discard state to {label}: {error}");
        }
    }
    CHANGED.notify_waiters();
}
pub fn release_window(app: &AppHandle, label: &str) {
    if !is_app_window(label) {
        return;
    }
    let events = STATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .release(label);
    publish(app, events);
}
pub fn page_loading(app: &AppHandle, label: &str) {
    if !is_app_window(label) {
        return;
    }
    let events = STATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .loading(label);
    publish(app, events);
}
#[derive(Serialize)]
pub struct Registration {
    token: String,
    events: Vec<Event>,
}
#[tauri::command]
pub fn git_discard_register(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Registration, String> {
    if !is_app_window(window.label()) {
        return Err("Only editor windows coordinate Discard".into());
    }
    let (token, events) = STATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .register(window.label());
    let snapshot = events
        .iter()
        .filter(|(label, event)| label == window.label() && event.token == token)
        .map(|(_, event)| event.clone())
        .collect();
    publish(&app, events);
    Ok(Registration {
        token,
        events: snapshot,
    })
}
#[tauri::command]
pub fn git_discard_unregister(app: AppHandle, window: tauri::WebviewWindow, token: String) {
    let events = {
        let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
        if state.clients.get(window.label()) != Some(&token) {
            return;
        }
        state.release(window.label())
    };
    publish(&app, events);
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
#[tauri::command]
pub async fn git_discard_begin(
    app: AppHandle,
    window: tauri::WebviewWindow,
    token: String,
    nonce: String,
    repo_root: String,
    entries: Vec<DiscardEntry>,
    workspace: Option<WorkspaceEnv>,
) -> Result<String, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let checked_app = app.clone();
    let root = repo_root.clone();
    let (scope, work) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        plan(
            &checked_app.state::<WorkspaceRegistry>(),
            root,
            entries,
            workspace,
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    let windows = app
        .webview_windows()
        .into_keys()
        .filter(|label| is_app_window(label))
        .collect();
    let (id, events) = STATE.lock().unwrap_or_else(|e| e.into_inner()).begin(
        window.label(),
        &token,
        nonce,
        windows,
        scope,
        work,
    )?;
    publish(&app, events);
    let timeout_id = id.clone();
    let timeout_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let events = {
            let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
            if state
                .active
                .as_ref()
                .is_some_and(|r| r.id == timeout_id && r.phase == "preparing")
            {
                state.finish(&timeout_id, false)
            } else {
                vec![]
            }
        };
        publish(&timeout_app, events);
    });
    Ok(id)
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
pub async fn git_discard_match_documents(
    app: AppHandle,
    window: tauri::WebviewWindow,
    token: String,
    id: String,
    paths: Vec<String>,
) -> Result<Vec<bool>, String> {
    let scope = {
        let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
        state
            .active
            .as_ref()
            .filter(|r| r.id == id && r.members.get(window.label()) == Some(&token))
            .map(|r| r.scope.clone())
            .ok_or("Discard identity lookup expired")?
    };
    crate::modules::fs::blocking(move || {
        match_documents(&app.state::<WorkspaceRegistry>(), &scope, &paths)
    })
    .await
}
#[tauri::command]
pub fn git_discard_prepared(
    app: AppHandle,
    window: tauri::WebviewWindow,
    token: String,
    id: String,
    ok: bool,
) {
    let events =
        STATE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .prepared(window.label(), &token, &id, ok);
    publish(&app, events);
}
#[tauri::command]
pub fn git_discard_status(
    window: tauri::WebviewWindow,
    token: String,
    id: String,
) -> Result<Status, String> {
    STATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .status(window.label(), &token, &id)
}
#[tauri::command]
pub fn git_discard_settled(window: tauri::WebviewWindow, token: String, id: String) {
    STATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .settled(window.label(), &token, &id);
}
#[tauri::command]
pub fn git_discard_cancel(
    app: AppHandle,
    window: tauri::WebviewWindow,
    token: String,
    id: String,
) -> Result<Status, String> {
    let (events, status) = {
        let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
        let owned = state.active.as_ref().is_some_and(|r| {
            r.id == id
                && r.owner == window.label()
                && r.owner_token == token
                && r.phase == "preparing"
        });
        let events = if owned {
            state.finish(&id, false)
        } else {
            vec![]
        };
        (events, state.status(window.label(), &token, &id)?)
    };
    publish(&app, events);
    Ok(status)
}
pub async fn execute(
    app: AppHandle,
    owner: String,
    token: String,
    id: String,
) -> Result<(), String> {
    let work = loop {
        let notified = CHANGED.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let work = STATE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take_work(&owner, &token, &id)?;
        if let Some(work) = work {
            break work;
        }
        notified.await;
    };
    tauri::async_runtime::spawn_blocking(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            work.execute(&app.state::<WorkspaceRegistry>(), &|path| crate::modules::fs::native_store::refuse_write(&app, path))
        }))
        .unwrap_or_else(|_| {
            Err("Git Discard failed unexpectedly; editor drafts were retained".into())
        });
        let events = STATE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .finish(&id, result.is_ok());
        publish(&app, events);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn start(state: &mut State) -> (String, String, String) {
        let (a, _) = state.register("main");
        let (b, _) = state.register("w-b");
        let (id, events) = state
            .begin(
                "main",
                &a,
                "nonce".into(),
                vec!["main".into(), "w-b".into()],
                Scope {
                    paths: vec!["/repo/file".into()],
                    workspace: WorkspaceEnv::Local,
                },
                Work {
                    repo: None,
                    entries: vec![],
                },
            )
            .unwrap();
        assert_eq!(events.len(), 2);
        (a, b, id)
    }
    #[test]
    fn every_window_must_prepare_and_only_the_owner_can_start() {
        let mut state = State::default();
        let (a, b, id) = start(&mut state);
        assert!(state.take_work("main", &a, &id).unwrap().is_none());
        state.prepared("main", &a, &id, true);
        state.prepared("w-b", &a, &id, true);
        assert!(state.take_work("main", &a, &id).unwrap().is_none());
        assert!(state.take_work("w-b", &b, &id).is_err());
        state.prepared("w-b", &b, &id, true);
        assert!(state.take_work("main", &a, &id).unwrap().is_some());
        assert!(state.take_work("main", &a, &id).is_err());
    }
    #[test]
    fn reload_or_new_page_cancels_preparation_and_old_acks_cannot_restart_it() {
        for label in ["w-b", "w-new"] {
            let mut state = State::default();
            let (a, b, id) = start(&mut state);
            let (_, events) = state.register(label);
            assert!(events.iter().any(|(_, e)| e.phase == "cancel"));
            state.prepared("w-b", &b, &id, true);
            state.prepared("main", &a, &id, true);
            assert!(state.take_work("main", &a, &id).is_err());
        }
    }
    #[test]
    fn running_worker_survives_owner_close_and_new_page_joins() {
        let mut state = State::default();
        let (a, b, id) = start(&mut state);
        state.prepared("main", &a, &id, true);
        state.prepared("w-b", &b, &id, true);
        state.take_work("main", &a, &id).unwrap().unwrap();
        state.release("main");
        let (replacement, events) = state.register("main");
        assert_eq!(events.len(), 1);
        assert!(!events[0].1.owner);
        assert_eq!(events[0].1.phase, "prepare");
        assert_eq!(state.finish(&id, true).len(), 2);
        assert!(state.status("main", &replacement, &id).unwrap().ok);
        assert!(state.status("main", &a, &id).is_err());
    }
    #[test]
    fn outcome_is_retained_until_every_participant_settles() {
        let mut state = State::default();
        let (a, b, id) = start(&mut state);
        state.finish(&id, false);
        state.settled("main", &b, &id);
        state.settled("main", &a, "stale");
        assert!(state.active.is_some());
        state.settled("main", &a, &id);
        assert_eq!(state.status("w-b", &b, &id).unwrap().phase, "finished");
        state.settled("w-b", &b, &id);
        assert!(state.active.is_none());
        assert_eq!(state.status("main", &a, &id).unwrap().phase, "gone");
    }
    #[test]
    fn unavailable_windows_and_overlapping_discards_are_refused() {
        let mut state = State::default();
        let (a, _) = state.register("main");
        let scope = Scope {
            paths: vec![],
            workspace: WorkspaceEnv::Local,
        };
        let work = Work {
            repo: None,
            entries: vec![],
        };
        assert!(state
            .begin(
                "main",
                &a,
                "n".into(),
                vec!["main".into(), "w-loading".into()],
                scope.clone(),
                work.clone()
            )
            .is_err());
        let (_a, _, _) = start(&mut state);
        assert!(state
            .begin("main", &a, "n".into(), vec!["main".into()], scope, work)
            .is_err());
    }
    #[test]
    fn timeout_or_failed_preparation_never_dispatches_git() {
        for timeout in [false, true] {
            let mut state = State::default();
            let (a, b, id) = start(&mut state);
            if timeout {
                state.finish(&id, false);
            } else {
                state.prepared("w-b", &b, &id, false);
            }
            assert!(state.take_work("main", &a, &id).is_err());
            assert!(!state.status("main", &a, &id).unwrap().ok);
        }
    }
    #[test]
    fn booting_page_keeps_completion_until_it_can_register() {
        let mut state = State::default();
        let (a, b, id) = start(&mut state);
        state.prepared("main", &a, &id, true);
        state.prepared("w-b", &b, &id, true);
        state.take_work("main", &a, &id).unwrap().unwrap();
        state.loading("w-new");
        state.finish(&id, true);
        state.settled("main", &a, &id);
        state.settled("w-b", &b, &id);
        assert!(state.active.is_some());
        let (token, events) = state.register("w-new");
        assert_eq!(events.len(), 2);
        assert!(!events[0].1.owner);
        assert_eq!(events[1].1.phase, "complete");
        state.settled("w-new", &token, &id);
        assert!(state.active.is_none());
    }
    #[test]
    fn closing_an_unregistered_page_releases_its_finished_membership() {
        let mut state = State::default();
        let (a, b, id) = start(&mut state);
        state.loading("w-new");
        assert!(state.take_work("main", &a, &id).is_err());
        state.settled("main", &a, &id);
        state.settled("w-b", &b, &id);
        state.release("w-new");
        assert!(state.active.is_none());
    }
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
