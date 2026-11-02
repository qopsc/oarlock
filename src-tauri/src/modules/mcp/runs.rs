//! One record per agent turn. The page registers a run once, attaches the project whose MCP
//! servers the turn keeps callable, and ends it; Stop, reload and window destruction remove it
//! natively, without waiting for the page.
use super::{project, McpState};
use crate::modules::net::page::NetworkPages;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const CHANGED: &str = "mcp:run-leases-changed";

fn valid_run_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[tauri::command]
pub fn ai_run_begin(
    app: AppHandle,
    window: WebviewWindow,
    run_id: String,
    chat_id: String,
    page_generation: String,
) -> Result<serde_json::Value, String> {
    super::require_app_window(&window)?;
    if !valid_run_id(&run_id) {
        return Err("mcp: invalid run id".into());
    }
    let label = window.label().to_owned();
    let state = app.state::<McpState>();
    // A queued call from a page that has since reloaded carries the old generation and is
    // refused here, so it cannot create an owner and a record nothing will end.
    let ((), status) = app.state::<NetworkPages>().with_page(&label, &page_generation, || {
        let owner = state
            .leases
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .owner(&label);
        crate::modules::ai_chat_control::admit_register(&app, &label, &chat_id, || {
            state
                .leases
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .begin_run(&label, &owner, &run_id, &chat_id)
        })
    })?;
    Ok(status)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOpened {
    project_key: Option<String>,
    projects: Vec<project::ProjectServers>,
}

#[tauri::command]
pub async fn ai_run_mcp_open(
    app: AppHandle,
    window: WebviewWindow,
    run_id: String,
    root: Option<String>,
    workspace: Option<crate::modules::workspace::WorkspaceEnv>,
    page_generation: String,
) -> Result<RunOpened, String> {
    super::require_app_window(&window)?;
    if !valid_run_id(&run_id) {
        return Err("mcp: invalid run id".into());
    }
    let label = window.label().to_owned();
    let owner = app.state::<NetworkPages>().with_page(&label, &page_generation, || {
        Ok(app
            .state::<McpState>()
            .leases
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .owner(&label))
    })?;
    crate::modules::fs::blocking(move || {
        let (retained, key) = project::resolve_run_project(&app, root, workspace)?;
        app.state::<NetworkPages>().with_page(&label, &page_generation, || {
            app.state::<McpState>()
                .leases
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .set_run_project(&label, &owner, &run_id, retained)
        })?;
        Ok(RunOpened {
            project_key: key,
            projects: project::run_listings(&app, &label),
        })
    })
    .await
}

#[tauri::command]
pub fn ai_run_end(app: AppHandle, window: WebviewWindow, run_id: String) {
    let held = app
        .state::<McpState>()
        .leases
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .end_run(window.label(), &run_id);
    if held {
        let _ = app.emit_to(window.label(), CHANGED, ());
    }
}

/// Stop: every record of the chat goes, in every window.
pub fn revoke_chat(app: &AppHandle, chat_id: &str) {
    let Some(state) = app.try_state::<McpState>() else {
        return;
    };
    let held = state
        .leases
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .revoke_chat(chat_id);
    if held {
        let _ = app.emit(CHANGED, ());
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn run_commands_require_the_native_page_generation() {
        let source = include_str!("runs.rs");
        let body = &source[..source.find("#[cfg(test)]").unwrap()];
        assert_eq!(body.matches("with_page(").count(), 3);
        for command in ["ai_run_begin", "ai_run_mcp_open"] {
            let from = body.find(&format!("pub fn {command}")).or_else(|| body.find(&format!("pub async fn {command}"))).unwrap();
            assert!(body[from..].contains("page_generation: String"));
        }
    }
    #[test]
    fn a_stale_generation_cannot_create_an_owner() {
        use crate::modules::net::page::NetworkPages;
        let pages = NetworkPages::default();
        pages.begin("main", || {}).unwrap();
        let old = pages.finish("main").unwrap();
        pages.begin("main", || {}).unwrap();
        let new = pages.finish("main").unwrap();
        let mut ran = false;
        assert!(pages
            .with_page("main", &old, || {
                ran = true;
                Ok(())
            })
            .is_err());
        assert!(!ran);
        assert!(pages.with_page("main", &new, || Ok(())).is_ok());
    }
    #[test]
    fn run_ids_are_32_lowercase_hex_characters() {
        assert!(super::valid_run_id("0123456789abcdef0123456789abcdef"));
        for bad in ["", "ABCDEF0123456789abcdef0123456789", "short", "0123456789abcdef0123456789abcdeg"] {
            assert!(!super::valid_run_id(bad));
        }
    }
}
