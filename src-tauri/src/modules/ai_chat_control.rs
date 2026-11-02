//! Shared Stop barrier. New turns are refused until every window and owned job settles.
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct ChatControl(Mutex<Control>, Condvar);
#[derive(Default)]
struct Control {
    chats: HashMap<String, Chat>,
    token: u64,
    revision: u64,
}
#[derive(Default)]
struct Chat {
    owners: HashSet<String>,
    stop: Option<Stop>,
}
struct Stop {
    token: u64,
    waiting: HashSet<String>,
    running: bool,
    error: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    chat_id: String,
    revision: u64,
    blocked: bool,
    error: Option<String>,
}
impl Control {
    fn status(&self, id: &str) -> Status {
        let stop = self.chats.get(id).and_then(|c| c.stop.as_ref());
        Status {
            chat_id: id.into(),
            revision: self.revision,
            blocked: stop.is_some(),
            error: stop.and_then(|s| s.error.clone()),
        }
    }
    fn admit_in<T>(
        &mut self,
        window: &str,
        chat_id: &str,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        if self.status(chat_id).blocked {
            return Err("This chat is stopping; no new work may start yet.".into());
        }
        self.chats
            .entry(chat_id.into())
            .or_default()
            .owners
            .insert(window.into());
        operation()
    }
    fn begin(&mut self, id: &str) -> Option<(u64, Vec<String>)> {
        let chat = self.chats.entry(id.into()).or_default();
        if chat.stop.as_ref().is_some_and(|s| s.running) {
            return None;
        }
        self.token += 1;
        self.revision += 1;
        let waiting = chat.owners.clone();
        let owners = waiting.iter().cloned().collect();
        chat.stop = Some(Stop {
            token: self.token,
            waiting,
            running: true,
            error: None,
        });
        Some((self.token, owners))
    }
    fn ack(&mut self, id: &str, token: u64, owner: &str, error: Option<String>) {
        if let Some(stop) = self
            .chats
            .get_mut(id)
            .and_then(|c| c.stop.as_mut())
            .filter(|s| s.token == token)
        {
            if stop.waiting.remove(owner) && error.is_some() {
                stop.error = error;
            }
        }
    }
    fn finish(&mut self, id: &str, token: u64, result: &Result<(), String>) {
        if let Some(chat) = self.chats.get_mut(id) {
            if chat.stop.as_ref().is_some_and(|s| s.token == token) {
                self.revision += 1;
                match result {
                    Ok(()) => chat.stop = None,
                    Err(error) => {
                        let stop = chat.stop.as_mut().unwrap();
                        stop.running = false;
                        stop.error = Some(error.clone());
                    }
                }
            }
        }
    }
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn admit<T>(
    app: &tauri::AppHandle,
    chat_id: Option<&str>,
    operation: impl FnOnce() -> T,
) -> Result<T, String> {
    let holder = app.state::<ChatControl>();
    let state = holder.0.lock().unwrap_or_else(|e| e.into_inner());
    if chat_id.is_some_and(|id| state.status(id).blocked) {
        return Err("This chat is stopping; no new work may start yet.".into());
    }
    Ok(operation())
}

/// Registers the window as an owner of the chat and runs `operation`, both under the lock that
/// Stop takes to block the chat, so a run record is never inserted after Stop revoked the chat.
/// Lock order: this lock, then the run records'.
pub fn admit_register<T>(
    app: &tauri::AppHandle,
    window: &str,
    chat_id: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<(T, serde_json::Value), String> {
    if !valid_id(chat_id) {
        return Err("Invalid conversation id".into());
    }
    let holder = app.state::<ChatControl>();
    let mut state = holder.0.lock().unwrap_or_else(|e| e.into_inner());
    let value = state.admit_in(window, chat_id, operation)?;
    Ok((value, serde_json::json!(state.status(chat_id))))
}

/// What Stop does after asking the windows to clean up. Revoking the chat's run records comes
/// first and does not depend on a window answering or on an emission having succeeded.
pub(crate) struct CleanupSteps<'a> {
    pub revoke_runs: &'a dyn Fn(),
    pub foreground: &'a dyn Fn(),
    pub background: &'a dyn Fn(),
    pub subagents: &'a dyn Fn(),
}
pub(crate) fn run_cleanup(
    steps: &CleanupSteps,
    background: bool,
    subagents: bool,
    emission_error: Option<String>,
) -> Result<(), String> {
    (steps.revoke_runs)();
    (steps.foreground)();
    if background {
        (steps.background)();
    }
    if subagents {
        (steps.subagents)();
    }
    emission_error.map_or(Ok(()), Err)
}

#[tauri::command]
pub fn ai_chat_register(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    chat_id: String,
) -> Result<serde_json::Value, String> {
    if !valid_id(&chat_id) {
        return Err("Invalid conversation id".into());
    }
    let holder = app.state::<ChatControl>();
    let mut state = holder.0.lock().unwrap_or_else(|e| e.into_inner());
    state
        .chats
        .entry(chat_id.clone())
        .or_default()
        .owners
        .insert(window.label().into());
    Ok(serde_json::json!(state.status(&chat_id)))
}
#[tauri::command]
pub fn ai_chat_stop_ack(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    chat_id: String,
    token: u64,
    error: Option<String>,
) {
    let holder = app.state::<ChatControl>();
    holder
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .ack(&chat_id, token, window.label(), error);
    holder.1.notify_all();
}
pub fn release_window(app: &tauri::AppHandle, label: &str) {
    let Some(holder) = app.try_state::<ChatControl>() else {
        return;
    };
    let mut state = holder.0.lock().unwrap_or_else(|e| e.into_inner());
    state.chats.retain(|_, chat| {
        chat.owners.remove(label);
        if let Some(stop) = chat.stop.as_mut() {
            stop.waiting.remove(label);
        }
        !chat.owners.is_empty() || chat.stop.is_some()
    });
    holder.1.notify_all();
}
#[tauri::command]
pub async fn ai_chat_stop(
    app: tauri::AppHandle,
    chat_id: String,
    stop_background: bool,
    stop_subagents: bool,
) -> Result<(), String> {
    if !valid_id(&chat_id) {
        return Err("Invalid conversation id".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        stop(&app, &chat_id, stop_background, stop_subagents)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn stop(app: &tauri::AppHandle, id: &str, background: bool, subagents: bool) -> Result<(), String> {
    let holder = app.state::<ChatControl>();
    let mut state = holder.0.lock().unwrap_or_else(|e| e.into_inner());
    let Some((token, owners)) = state.begin(id) else {
        while state
            .chats
            .get(id)
            .and_then(|c| c.stop.as_ref())
            .is_some_and(|s| s.running)
        {
            state = holder.1.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        return state
            .chats
            .get(id)
            .and_then(|c| c.stop.as_ref())
            .and_then(|s| s.error.clone())
            .map_or(Ok(()), Err);
    };
    let _ = app.emit("ai:chat-stop-state", state.status(id));
    drop(state);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut emission_error = None;
        for owner in owners {
            if let Err(error) = app.emit_to(
                owner,
                "ai:chat-stop",
                serde_json::json!({"chatId":id,"token":token}),
            ) {
                emission_error = Some(error.to_string());
            }
        }
        run_cleanup(
            &CleanupSteps {
                revoke_runs: &|| super::mcp::runs::revoke_chat(app, id),
                foreground: &|| {
                    app.state::<super::shell::ShellState>()
                        .stop_chat_foreground(id)
                },
                background: &|| {
                    app.state::<super::shell::ShellState>()
                        .kill_chat_background(id)
                },
                subagents: &|| super::ai_subagents::cancel_chat(app, id),
            },
            background,
            subagents,
            emission_error,
        )?;
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut state = holder.0.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            let stop = state
                .chats
                .get(id)
                .and_then(|c| c.stop.as_ref())
                .ok_or("Stop state disappeared")?;
            if stop.waiting.is_empty() {
                if let Some(error) = &stop.error {
                    return Err(error.clone());
                }
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(
                    "A window has not finished stopping. Retry Stop before sending another turn."
                        .into(),
                );
            }
            state = holder
                .1
                .wait_timeout(state, remaining)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        drop(state);
        if background {
            app.state::<super::shell::ShellState>()
                .stop_chat_background_and_wait(id)?;
        }
        if subagents {
            super::ai_subagents::cancel_chat_and_wait(app, id)?;
        }
        Ok(())
    }))
    .unwrap_or_else(|_| {
        Err("Stop cleanup failed unexpectedly. Retry Stop before sending another turn.".into())
    });
    let mut state = holder.0.lock().unwrap_or_else(|e| e.into_inner());
    state.finish(id, token, &result);
    let _ = app.emit("ai:chat-stop-state", state.status(id));
    holder.1.notify_all();
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn stop_revokes_run_records_even_when_an_emission_failed_and_before_anything_waits() {
        for (background, subagents) in [(false, false), (true, true)] {
            let log = RefCell::new(Vec::new());
            let step = |name: &'static str| {
                let log = &log;
                move || log.borrow_mut().push(name)
            };
            let (revoke, foreground, bg, sub) =
                (step("revoke"), step("foreground"), step("background"), step("subagents"));
            let result = run_cleanup(
                &CleanupSteps {
                    revoke_runs: &revoke,
                    foreground: &foreground,
                    background: &bg,
                    subagents: &sub,
                },
                background,
                subagents,
                Some("emit failed".into()),
            );
            assert_eq!(result, Err("emit failed".into()));
            let log = log.borrow();
            assert_eq!(log[0], "revoke");
            assert_eq!(log.contains(&"background"), background);
            assert_eq!(log.contains(&"subagents"), subagents);
        }
    }
    #[test]
    fn ai_run_begin_is_refused_while_the_chat_is_stopping() {
        let mut state = Control::default();
        let ran = RefCell::new(0);
        state.admit_in("w", "chat", || Ok(*ran.borrow_mut() += 1)).unwrap();
        assert_eq!(*ran.borrow(), 1);
        state.begin("chat").unwrap();
        assert!(state.admit_in("w", "chat", || Ok(*ran.borrow_mut() += 1)).is_err());
        assert_eq!(*ran.borrow(), 1);
        assert!(state.admit_in("w", "other", || Ok(())).is_ok());
    }
    #[test]
    fn stop_passes_the_real_revocation_to_its_cleanup_sequence() {
        let source = include_str!("ai_chat_control.rs");
        let from = source.find("fn stop(app").unwrap();
        let stop = &source[from..from + source[from..].find("#[cfg(test)]").unwrap()];
        assert!(stop.contains("revoke_runs: &|| super::mcp::runs::revoke_chat(app, id)"));
    }
    #[test]
    fn barrier_waits_for_every_owner_and_failure_requires_retry() {
        let mut state = Control::default();
        state
            .chats
            .entry("chat".into())
            .or_default()
            .owners
            .extend(["a".into(), "b".into()]);
        let (token, _) = state.begin("chat").unwrap();
        assert!(state.status("chat").blocked);
        assert!(state.begin("chat").is_none());
        state.ack("chat", token, "a", None);
        assert_eq!(state.chats["chat"].stop.as_ref().unwrap().waiting.len(), 1);
        state.finish("chat", token, &Err("failed".into()));
        assert!(state.status("chat").blocked);
        let (retry, _) = state.begin("chat").unwrap();
        state.ack("chat", token, "b", None);
        assert_eq!(state.chats["chat"].stop.as_ref().unwrap().waiting.len(), 2);
        state.finish("chat", retry, &Ok(()));
        assert!(!state.status("chat").blocked);
    }
    #[test]
    fn stale_stop_cannot_release_a_retry_or_block_another_chat() {
        let mut state = Control::default();
        let (first, _) = state.begin("a").unwrap();
        state.finish("a", first, &Err("failed".into()));
        let (retry, _) = state.begin("a").unwrap();
        state.finish("a", first, &Ok(()));
        assert!(state.status("a").blocked);
        assert!(!state.status("b").blocked);
        state.finish("a", retry, &Ok(()));
        assert!(!state.status("a").blocked);
    }
    #[test]
    fn acknowledgments_only_count_for_registered_owners_and_current_token() {
        let mut state = Control::default();
        state
            .chats
            .entry("a".into())
            .or_default()
            .owners
            .insert("owner".into());
        let (token, _) = state.begin("a").unwrap();
        state.ack("a", token, "stranger", Some("error".into()));
        state.ack("a", token + 1, "owner", None);
        let stop = state.chats["a"].stop.as_ref().unwrap();
        assert_eq!(stop.waiting.len(), 1);
        assert!(stop.error.is_none());
        state.ack("a", token, "owner", None);
        assert!(state.chats["a"].stop.as_ref().unwrap().waiting.is_empty());
    }
}
