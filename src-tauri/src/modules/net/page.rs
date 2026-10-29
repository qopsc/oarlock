//! Page generations for native HTTP work. Native publishes only after document
//! load, so a queued old-page IPC cannot obtain its replacement's generation.
use std::{
    collections::HashMap,
    sync::{Mutex, PoisonError},
};
use tauri::Manager;

#[derive(Default)]
pub struct NetworkPages(Mutex<HashMap<String, Page>>);
struct Page {
    token: String,
    ready: bool,
}

impl NetworkPages {
    pub fn begin(&self, window: &str, cleanup: impl FnOnce()) -> Result<(), String> {
        let mut pages = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        pages.remove(window);
        cleanup();
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| format!("Network page entropy: {e}"))?;
        let token = bytes.iter().map(|b| format!("{b:02x}")).collect();
        pages.insert(
            window.into(),
            Page {
                token,
                ready: false,
            },
        );
        Ok(())
    }

    pub fn finish(&self, window: &str) -> Option<String> {
        let mut pages = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let page = pages.get_mut(window)?;
        page.ready = true;
        Some(page.token.clone())
    }

    pub fn close(&self, window: &str, cleanup: impl FnOnce()) {
        let mut pages = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        pages.remove(window);
        cleanup();
    }

    pub fn with_page<T>(
        &self,
        window: &str,
        token: &str,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let pages = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if !pages
            .get(window)
            .is_some_and(|page| page.ready && page.token == token)
        {
            return Err("Network request belongs to an expired or unavailable page".into());
        }
        // Keep the generation lock through registration/ack/cancel. Retirement
        // takes this same lock before cancelling all registered work.
        action()
    }
}

pub fn cancel_requests(app: &tauri::AppHandle, window: &str) {
    if let Some(state) = app.try_state::<crate::modules::fs::interactive::SearchRequests>() {
        state.cancel_window(window);
    }
    if let Some(state) = app.try_state::<crate::modules::clipboard_write::ClipboardWrites>() {
        state.release_window(window);
    }
    if let Some(state) = app.try_state::<crate::modules::lsp::LspState>() {
        state.release_window(window);
    }
    crate::modules::mcp::oauth::cancel_probe_window(app, window);
    if let Some(state) = app.try_state::<super::probe::ProbeRequests>() {
        state.cancel_window(window);
    }
    if let Some(state) = app.try_state::<super::AiStreamState>() {
        state.cancel_window(window);
    }
    if let Some(state) = app.try_state::<super::image::ImageRequests>() {
        state.cancel_window(window);
    }
    if let Some(state) = app.try_state::<crate::modules::mcp::McpHttpStreams>() {
        state.cancel_window(window);
    }
}

pub fn on_load(webview: &tauri::Webview, event: tauri::webview::PageLoadEvent) {
    let pages = webview.state::<NetworkPages>();
    match event {
        tauri::webview::PageLoadEvent::Started => {
            if let Err(error) = pages.begin(webview.label(), || {
                cancel_requests(webview.app_handle(), webview.label())
            }) {
                log::error!("{error}");
            }
        }
        tauri::webview::PageLoadEvent::Finished => {
            if let Some(token) = pages.finish(webview.label()) {
                if let Err(error) = webview.eval(delivery_script(&token)) {
                    log::error!("Could not deliver network page generation: {error}");
                }
            }
        }
    }
}

pub fn delivery_script(token: &str) -> String {
    let token = serde_json::to_string(token).expect("string serialization");
    format!("window.__OARLOCK_NETWORK_PAGE__ = {token}; window.dispatchEvent(new Event('oarlock:network-page'));")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_finished_current_pages_can_admit_work() {
        let pages = NetworkPages::default();
        assert!(pages.with_page("main", "", || Ok(())).is_err());
        pages.begin("main", || {}).unwrap();
        let token = pages.0.lock().unwrap()["main"].token.clone();
        assert!(pages.with_page("main", &token, || Ok(())).is_err());
        assert_eq!(pages.finish("main"), Some(token.clone()));
        assert!(pages.with_page("main", &token, || Ok(())).is_ok());
        assert!(pages.with_page("other", &token, || Ok(())).is_err());
        pages.begin("main", || {}).unwrap();
        let replacement = pages.finish("main").unwrap();
        assert_ne!(token, replacement);
        assert!(pages.with_page("main", &token, || Ok(())).is_err());
        pages.close("main", || {});
        assert!(pages.finish("main").is_none());
        assert!(pages.with_page("main", &replacement, || Ok(())).is_err());
    }

    #[test]
    fn retirement_cancels_admitted_work_before_its_first_io_poll() {
        use futures_util::{future::Abortable, FutureExt};
        let pages = NetworkPages::default();
        let states = [
            super::super::AiStreamState::default(),
            super::super::AiStreamState::default(),
            super::super::AiStreamState::default(),
        ];
        pages.begin("main", || {}).unwrap();
        let token = pages.finish("main").unwrap();
        let tickets: Vec<_> = states
            .iter()
            .map(|state| {
                pages
                    .with_page("main", &token, || state.start("main", "r"))
                    .unwrap()
            })
            .collect();
        pages
            .begin("main", || {
                for state in &states {
                    state.cancel_window("main");
                }
            })
            .unwrap();
        for (_lease, registration) in tickets {
            let future = async { panic!("retired request started I/O") };
            assert!(Abortable::new(future, registration)
                .now_or_never()
                .unwrap()
                .is_err());
        }
    }

    #[test]
    fn stale_cancellation_and_credit_cannot_touch_the_replacement_page() {
        use futures_util::{future::Abortable, FutureExt};
        let pages = NetworkPages::default();
        let state = super::super::AiStreamState::default();
        pages.begin("main", || {}).unwrap();
        let old = pages.finish("main").unwrap();
        pages.begin("main", || state.cancel_window("main")).unwrap();
        let current = pages.finish("main").unwrap();
        let (lease, registration) = pages
            .with_page("main", &current, || state.start("main", "same-id"))
            .unwrap();
        lease
            .control
            .try_reserve(super::super::stream::CHUNK_BYTES)
            .unwrap();
        assert!(pages
            .with_page("main", &old, || state.acknowledge("main", "same-id", 1))
            .is_err());
        assert!(pages
            .with_page("main", &old, || {
                state.cancel("main", "same-id");
                Ok(())
            })
            .is_err());
        let mut waiting = Box::pin(Abortable::new(std::future::pending::<()>(), registration));
        assert!(waiting.as_mut().now_or_never().is_none());
        pages
            .with_page("main", &current, || {
                state.cancel("main", "same-id");
                Ok(())
            })
            .unwrap();
        assert!(waiting.as_mut().now_or_never().unwrap().is_err());
    }

    #[test]
    fn registration_and_retirement_are_one_serialized_boundary() {
        use futures_util::{future::Abortable, FutureExt};
        let pages = std::sync::Arc::new(NetworkPages::default());
        let state = super::super::AiStreamState::default();
        pages.begin("main", || {}).unwrap();
        let token = pages.finish("main").unwrap();
        let (entered, waiting) = std::sync::mpsc::channel();
        let (resume, resumed) = std::sync::mpsc::channel();
        let admission = std::thread::spawn({
            let pages = pages.clone();
            let state = state.clone();
            move || {
                pages
                    .with_page("main", &token, || {
                        entered.send(()).unwrap();
                        resumed.recv().unwrap();
                        state.start("main", "r")
                    })
                    .unwrap()
            }
        });
        waiting.recv().unwrap();
        let retirement = std::thread::spawn({
            let pages = pages.clone();
            move || pages.close("main", || state.cancel_window("main"))
        });
        resume.send(()).unwrap();
        let (_lease, registration) = admission.join().unwrap();
        retirement.join().unwrap();
        assert!(Abortable::new(std::future::pending::<()>(), registration)
            .now_or_never()
            .unwrap()
            .is_err());
    }
}
