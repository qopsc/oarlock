//! Subagent records outlive their parent chat. Only the owning page may update a run.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;
const STORE: &str = "oarlock-subagents.json";
const COMPLETED_LIMIT: usize = 32;
const ACTIVE_LIMIT: usize = 8;
#[derive(Default)]
pub struct SubagentState(Mutex<State>, Condvar);
#[derive(Default)]
struct State {
    loaded: bool,
    revision: u64,
    next_owner: u64,
    owners: HashMap<String, u64>,
    tasks: Vec<Task>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    session_id: String,
    owner: String,
    owner_token: u64,
    title: String,
    kind: String,
    model_id: String,
    prompt: String,
    status: String,
    step: Option<String>,
    result: Option<String>,
    error: Option<String>,
    started_at: u64,
    finished_at: Option<u64>,
    input_tokens: u64,
    output_tokens: u64,
}
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Open,
    List,
    Start {
        token: u64,
        id: String,
        session_id: String,
        title: String,
        kind: String,
        model_id: String,
        prompt: String,
    },
    Update {
        token: u64,
        id: String,
        status: String,
        step: Option<String>,
        result: Option<String>,
        error: Option<String>,
        input_tokens: u64,
        output_tokens: u64,
    },
    Cancel {
        id: String,
    },
    CancelChat {
        session_id: String,
    },
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn bounded(mut value: String, limit: usize) -> String {
    let mut end = limit.min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    value
}
fn result_text(value: String) -> String {
    if value.len() <= 64000 {
        return value;
    }
    format!("{}\n\n[Result truncated]", bounded(value, 63970))
}
fn task_key(id: &str) -> String {
    format!("task:{id}")
}
fn validate_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn prune(state: &mut State) -> Vec<String> {
    state
        .tasks
        .sort_by_key(|task| std::cmp::Reverse(task.finished_at.unwrap_or(task.started_at)));
    let mut completed = 0;
    let mut removed = vec![];
    state.tasks.retain(|task| {
        if task.status == "running" {
            return true;
        }
        completed += 1;
        if completed <= COMPLETED_LIMIT {
            true
        } else {
            removed.push(task.id.clone());
            false
        }
    });
    removed
}
fn persist(app: &tauri::AppHandle, state: &mut State, task: Task) -> Result<(), String> {
    let store = app.store(STORE).map_err(|e| e.to_string())?;
    let removed = prune(state);
    for id in &removed {
        store.delete(task_key(id));
    }
    if state.tasks.iter().any(|kept| kept.id == task.id) {
        store.set(task_key(&task.id), json!(task));
    }
    state.revision += 1;
    app.state::<SubagentState>().1.notify_all();
    let _ = app.emit(
        "ai:subagent-task",
        json!({"revision":state.revision,"task":task,"removed":removed}),
    );
    if task.status != "running" {
        store.save().map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn load(app: &tauri::AppHandle, state: &mut State) -> Result<(), String> {
    if state.loaded {
        return Ok(());
    }
    let store = app.store(STORE).map_err(|e| e.to_string())?;
    let mut interrupted = vec![];
    for (key, value) in store.entries() {
        if !key.starts_with("task:") {
            continue;
        }
        let Ok(mut task) = serde_json::from_value::<Task>(value) else {
            continue;
        };
        if task.status == "running" {
            task.status = "interrupted".into();
            task.finished_at = Some(now());
            task.step = None;
            task.error = Some("The app closed before this subagent finished.".into());
            interrupted.push(task.clone());
        }
        state.tasks.push(task);
    }
    state.loaded = true;
    for task in interrupted {
        persist(app, state, task)?;
    }
    Ok(())
}
fn interrupt(state: &mut State, owner: &str) -> Vec<Task> {
    state.owners.remove(owner);
    let mut changed = vec![];
    for task in state
        .tasks
        .iter_mut()
        .filter(|t| t.owner == owner && t.status == "running")
    {
        task.status = "interrupted".into();
        task.finished_at = Some(now());
        task.step = None;
        task.error = Some("The owning window closed or reloaded.".into());
        changed.push(task.clone());
    }
    changed
}
pub fn release_window(app: &tauri::AppHandle, label: &str) {
    let Some(holder) = app.try_state::<SubagentState>() else {
        return;
    };
    let mut state = holder.0.lock().unwrap_or_else(|e| e.into_inner());
    for task in interrupt(&mut state, label) {
        let _ = persist(app, &mut state, task);
    }
    holder.1.notify_all();
}
#[tauri::command]
pub async fn ai_subagent_task(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Request,
) -> Result<Value, String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || dispatch(&app, &label, request))
        .await
        .map_err(|e| e.to_string())?
}
fn dispatch(app: &tauri::AppHandle, label: &str, request: Request) -> Result<Value, String> {
    let holder = app.state::<SubagentState>();
    let mut state = holder.0.lock().map_err(|e| e.to_string())?;
    if matches!(request, Request::CancelChat { .. }) && !state.loaded {
        return Ok(Value::Null);
    }
    load(app, &mut state)?;
    match request {
        Request::Open => {
            for task in interrupt(&mut state, label) {
                persist(app, &mut state, task)?;
            }
            state.next_owner += 1;
            let token = state.next_owner;
            state.owners.insert(label.into(), token);
            Ok(json!(token))
        }
        Request::List => Ok(json!({"revision":state.revision,"tasks":state.tasks})),
        Request::Start {
            token,
            id,
            session_id,
            title,
            kind,
            model_id,
            prompt,
        } => {
            if state.owners.get(label) != Some(&token) {
                return Err("subagent owner expired".into());
            }
            if !validate_id(&id)
                || !validate_id(&session_id)
                || state.tasks.iter().any(|t| t.id == id)
            {
                return Err("invalid subagent identity".into());
            }
            if state.tasks.iter().filter(|t| t.status == "running").count() >= ACTIVE_LIMIT {
                return Err("At most eight subagents can run at once.".into());
            }
            let task = Task {
                id,
                session_id,
                owner: label.into(),
                owner_token: token,
                title: bounded(title, 256),
                kind: bounded(kind, 64),
                model_id: bounded(model_id, 128),
                prompt: bounded(prompt, 8192),
                status: "running".into(),
                step: None,
                result: None,
                error: None,
                started_at: now(),
                finished_at: None,
                input_tokens: 0,
                output_tokens: 0,
            };
            super::ai_chat_control::admit(app, Some(&task.session_id), || {
                state.tasks.push(task.clone());
            })?;
            persist(app, &mut state, task.clone())?;
            Ok(json!(task))
        }
        Request::Update {
            token,
            id,
            status,
            step,
            result,
            error,
            input_tokens,
            output_tokens,
        } => {
            if state.owners.get(label) != Some(&token) {
                return Err("subagent owner expired".into());
            }
            if !matches!(
                status.as_str(),
                "running" | "completed" | "failed" | "cancelled"
            ) {
                return Err("invalid subagent status".into());
            }
            let task = state
                .tasks
                .iter_mut()
                .find(|t| t.id == id && t.owner == label && t.owner_token == token)
                .ok_or("unknown subagent")?;
            if task.status == "running" {
                task.status = status;
                task.step = step.map(|v| bounded(v, 256));
                task.result = result.map(result_text);
                task.error = error.map(|v| bounded(v, 2048));
                task.input_tokens = input_tokens;
                task.output_tokens = output_tokens;
                if task.status != "running" {
                    task.finished_at = Some(now());
                    task.step = None;
                }
            }
            let task = task.clone();
            persist(app, &mut state, task.clone())?;
            Ok(json!(task))
        }
        Request::Cancel { id } => {
            cancel(app, &state, |t| t.id == id);
            Ok(Value::Null)
        }
        Request::CancelChat { session_id } => {
            cancel(app, &state, |t| t.session_id == session_id);
            Ok(Value::Null)
        }
    }
}
fn cancel(app: &tauri::AppHandle, state: &State, matches: impl Fn(&Task) -> bool) {
    for task in state
        .tasks
        .iter()
        .filter(|t| t.status == "running" && matches(t))
    {
        let _ = app.emit_to(&task.owner, "ai:subagent-cancel", &task.id);
    }
}
pub fn cancel_chat_and_wait(app: &tauri::AppHandle, session_id: &str) -> Result<(), String> {
    let holder = app.state::<SubagentState>();
    let mut state = holder.0.lock().unwrap_or_else(|e| e.into_inner());
    if !state.loaded {
        return Ok(());
    }
    cancel(app, &state, |t| t.session_id == session_id);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while state
        .tasks
        .iter()
        .any(|t| t.session_id == session_id && t.status == "running")
    {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(
                "Subagents have not finished stopping. Retry Stop before sending another turn."
                    .into(),
            );
        }
        state = holder
            .1
            .wait_timeout(state, remaining)
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
    Ok(())
}

pub fn cancel_chat(app: &tauri::AppHandle, session_id: &str) {
    let holder = app.state::<SubagentState>();
    let state = holder.0.lock().unwrap_or_else(|e| e.into_inner());
    if state.loaded {
        cancel(app, &state, |t| t.session_id == session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits_preserve_unicode_boundaries() {
        assert_eq!(bounded("a🦀b".into(), 4), "a");
        assert!(!validate_id("../a"));
    }
    #[test]
    fn release_revokes_only_its_owners_token() {
        let mut state = State::default();
        state.owners.insert("a".into(), 1);
        state.owners.insert("b".into(), 2);
        interrupt(&mut state, "a");
        assert!(!state.owners.contains_key("a"));
        assert_eq!(state.owners.get("b"), Some(&2));
    }
    fn task(id: usize, status: &str) -> Task {
        Task {
            id: id.to_string(),
            session_id: "deleted-chat".into(),
            owner: "a".into(),
            owner_token: 1,
            title: "review".into(),
            kind: "reviewer".into(),
            model_id: "model".into(),
            prompt: "prompt".into(),
            status: status.into(),
            step: None,
            result: Some("saved result".into()),
            error: None,
            started_at: id as u64,
            finished_at: None,
            input_tokens: 3,
            output_tokens: 4,
        }
    }
    #[test]
    fn retention_keeps_running_tasks_and_recently_completed_long_runs() {
        let mut state = State {
            tasks: (1..=40).map(|id| task(id, "completed")).collect(),
            ..State::default()
        };
        let mut long_running = task(0, "completed");
        long_running.finished_at = Some(100);
        state.tasks.push(long_running);
        state.tasks.push(task(41, "running"));
        let removed = prune(&mut state);
        assert_eq!(removed.len(), 9);
        assert_eq!(state.tasks.len(), 33);
        assert!(state.tasks.iter().any(|t| t.id == "0"));
        assert!(state.tasks.iter().any(|t| t.id == "41"));
    }
    #[test]
    fn closing_owner_preserves_results_and_interrupts_only_its_running_tasks() {
        let mut state = State {
            tasks: vec![task(1, "running"), task(2, "completed"), task(3, "running")],
            ..State::default()
        };
        state.tasks[2].owner = "b".into();
        let changed = interrupt(&mut state, "a");
        assert_eq!(changed.len(), 1);
        assert_eq!(state.tasks[0].status, "interrupted");
        assert!(state.tasks[0].finished_at.is_some());
        assert_eq!(state.tasks[1].result.as_deref(), Some("saved result"));
        assert_eq!(state.tasks[2].status, "running");
    }
    #[test]
    fn frontend_requests_use_camel_case_and_results_truncate_visibly() {
        assert!(matches!(
            serde_json::from_value::<Request>(json!({"action":"cancelChat","sessionId":"chat"})),
            Ok(Request::CancelChat { .. })
        ));
        let result = result_text("a".repeat(65000));
        assert!(result.len() <= 64000);
        assert!(result.ends_with("[Result truncated]"));
    }
}
