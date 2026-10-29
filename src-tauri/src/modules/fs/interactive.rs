//! Interactive grep retains admission until its blocking walk actually stops.
use super::{
    authorized_root, blocking,
    grep::{run_grep_interactive, GrepChannel, GrepResponse},
    privacy_refused_root,
};
use crate::modules::{
    net::{page::NetworkPages, AiStreamState},
    workspace::{Origin, WorkspaceEnv},
};
use tauri::{ipc::Channel, AppHandle, State, Window};

#[derive(Default)]
pub struct SearchRequests(pub(crate) AiStreamState);
impl SearchRequests {
    pub fn cancel_window(&self, window: &str) {
        self.0.cancel_window(window);
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn fs_grep_interactive(
    app: AppHandle,
    window: Window,
    requests: State<'_, SearchRequests>,
    pages: State<'_, NetworkPages>,
    page_generation: String,
    request_id: String,
    pattern: String,
    root: String,
    max_results: Option<usize>,
    workspace: Option<WorkspaceEnv>,
    channel: Option<GrepChannel>,
    on_event: Channel<Result<GrepResponse, String>>,
) -> Result<(), String> {
    let (lease, registration) = pages.with_page(window.label(), &page_generation, || {
        requests
            .0
            .start(window.label(), &request_id)
            .map_err(|error| {
                format!(
                    "Could not start {:?} search: {}",
                    channel.unwrap_or_default(),
                    error.replace("AI request", "search request")
                )
            })
    })?;
    tauri::async_runtime::spawn(async move {
        let result = blocking(move || {
            // Keep the lease in this closure: dropping an async waiter must not
            // release admission while blocking filesystem work still runs.
            let _lease = lease;
            let abort = registration.handle();
            let cancelled = || abort.is_aborted();
            if cancelled() {
                return Err("Search cancelled".into());
            }
            authorized_root(&app, &root, workspace.as_ref(), Origin::App)?;
            if cancelled() {
                return Err("Search cancelled".into());
            }
            privacy_refused_root(&root)?;
            let result = run_grep_interactive(pattern, root, max_results, workspace, &cancelled)?;
            if cancelled() {
                return Err("Search cancelled".into());
            }
            Ok(result)
        })
        .await;
        let _ = on_event.send(result);
    });
    Ok(())
}

#[tauri::command]
pub fn fs_grep_cancel(
    window: Window,
    requests: State<'_, SearchRequests>,
    pages: State<'_, NetworkPages>,
    page_generation: String,
    request_id: String,
) -> Result<(), String> {
    pages.with_page(window.label(), &page_generation, || {
        requests.0.cancel(window.label(), &request_id);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_retirement_rejects_queued_pages_and_preserves_other_windows() {
        let requests = SearchRequests::default();
        let pages = NetworkPages::default();
        pages.begin("a", || {}).unwrap();
        pages.begin("b", || {}).unwrap();
        let a = pages.finish("a").unwrap();
        let b = pages.finish("b").unwrap();
        let (_a, ar) = pages
            .with_page("a", &a, || requests.0.start("a", "one"))
            .unwrap();
        let (_b, br) = pages
            .with_page("b", &b, || requests.0.start("b", "one"))
            .unwrap();
        pages.close("a", || requests.cancel_window("a"));
        assert!(ar.handle().is_aborted());
        assert!(!br.handle().is_aborted());
        assert!(pages
            .with_page("a", &a, || requests.0.start("a", "late"))
            .is_err());
        requests.0.cancel("b", "different");
        assert!(!br.handle().is_aborted());
    }
    #[test]
    fn a_delayed_old_cancellation_does_not_cancel_a_newer_search() {
        let requests = SearchRequests::default();
        let (_new, newer) = requests.0.start("main", "new").unwrap();
        // Old admission can arrive late. It must not supersede current work.
        let (_old, older) = requests.0.start("main", "old").unwrap();
        let (_sidebar, sidebar) = requests.0.start("main", "sidebar").unwrap();
        requests.0.cancel("main", "old");
        assert!(older.handle().is_aborted());
        assert!(!newer.handle().is_aborted());
        assert!(!sidebar.handle().is_aborted());
    }

    #[test]
    fn cancelled_walks_keep_their_slot_until_the_blocking_owner_finishes() {
        let requests = SearchRequests::default();
        let leases: Vec<_> = (0..16)
            .map(|i| requests.0.start("a", &format!("r{i}")).unwrap())
            .collect();
        requests.cancel_window("a");
        assert!(leases.iter().all(|(_, r)| r.handle().is_aborted()));
        assert!(requests.0.start("a", "overflow").is_err());
        drop(leases);
        assert!(requests.0.start("a", "next").is_ok());
    }
}
