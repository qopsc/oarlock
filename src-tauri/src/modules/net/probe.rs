//! Endpoint reachability probes have page ownership and a separate app-wide budget.
use super::{page::NetworkPages, stream::StreamLease, AiStreamState};
use futures_util::future::{AbortRegistration, Abortable};
use tauri::{ipc::Channel, State, WebviewWindow};

const MAX_PROBES: usize = 8;
type Ticket = (StreamLease, AbortRegistration);

#[derive(Default)]
pub struct ProbeRequests(AiStreamState);
impl ProbeRequests {
    fn admit(
        &self,
        pages: &NetworkPages,
        owner: &str,
        page: &str,
        id: &str,
    ) -> Result<Ticket, String> {
        pages.with_page(owner, page, || {
            self.0
                .start_bounded(owner, id, MAX_PROBES)
                .map_err(|error| {
                    if error == "too many active requests" {
                        "Connection probes are busy (8 active); try again".into()
                    } else {
                        error
                    }
                })
        })
    }
    pub fn cancel_window(&self, owner: &str) {
        self.0.cancel_window(owner);
    }
}

async fn run(ticket: Ticket, base_url: String) -> Result<u16, String> {
    let (lease, registration) = ticket;
    let result = Abortable::new(
        super::deadline::within(
            std::time::Duration::from_secs(5),
            "Connection probe",
            super::probe_endpoint(base_url),
        ),
        registration,
    )
    .await;
    drop(lease);
    result.map_err(|_| "Connection probe cancelled".to_owned())?
}

/// Return after registration so cancellation can retry if its IPC overtook admission.
#[tauri::command]
pub fn lm_ping(
    window: WebviewWindow,
    state: State<'_, ProbeRequests>,
    pages: State<'_, NetworkPages>,
    page_generation: String,
    request_id: String,
    base_url: String,
    on_event: Channel<Result<u16, String>>,
) -> Result<(), String> {
    let ticket = state.admit(&pages, window.label(), &page_generation, &request_id)?;
    tauri::async_runtime::spawn(async move {
        let _ = on_event.send(run(ticket, base_url).await);
    });
    Ok(())
}

#[tauri::command]
pub fn lm_ping_cancel(
    window: WebviewWindow,
    state: State<'_, ProbeRequests>,
    pages: State<'_, NetworkPages>,
    page_generation: String,
    request_id: String,
) -> Result<(), String> {
    pages.with_page(window.label(), &page_generation, || {
        state.0.cancel(window.label(), &request_id);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn retired_pages_cannot_admit_and_cancelled_admissions_never_start_io() {
        let pages = NetworkPages::default();
        let state = ProbeRequests::default();
        pages.begin("settings", || {}).unwrap();
        let old = pages.finish("settings").unwrap();
        let ticket = state.admit(&pages, "settings", &old, "probe").unwrap();
        pages
            .begin("settings", || state.cancel_window("settings"))
            .unwrap();
        let current = pages.finish("settings").unwrap();
        assert!(state.admit(&pages, "settings", &old, "queued").is_err());
        assert!(state.admit(&pages, "other", &current, "probe").is_err());
        // Invalid URL would fail validation if cancelled work reached I/O preparation.
        assert_eq!(
            run(ticket, "invalid".into()).await.unwrap_err(),
            "Connection probe cancelled"
        );
        assert!(state.admit(&pages, "settings", &current, "probe").is_ok());
    }

    #[tokio::test]
    async fn connection_probes_have_bounded_admission_and_close_their_sockets() {
        use tokio::{io::AsyncReadExt, net::TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (accepted, observed) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut sockets = Vec::new();
            for _ in 0..MAX_PROBES {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.windows(4).any(|v| v == b"\r\n\r\n") {
                    let mut buffer = [0; 1024];
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                sockets.push(socket);
            }
            accepted.send(()).unwrap();
            for mut socket in sockets {
                let closed = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut [0; 1]))
                    .await
                    .unwrap();
                assert!(closed.is_err() || closed.unwrap() == 0);
            }
        });
        let pages = NetworkPages::default();
        let state = ProbeRequests::default();
        pages.begin("settings", || {}).unwrap();
        let page = pages.finish("settings").unwrap();
        let mut callers = tokio::task::JoinSet::new();
        for id in 0..MAX_PROBES {
            let ticket = state
                .admit(&pages, "settings", &page, &id.to_string())
                .unwrap();
            callers.spawn(run(ticket, url.clone()));
        }
        // The budget is global, not per page, and independent from chat slots.
        pages.begin("second", || {}).unwrap();
        let second = pages.finish("second").unwrap();
        assert!(
            matches!(state.admit(&pages, "second", &second, "extra"), Err(error) if error.contains("8 active"))
        );
        assert!(AiStreamState::default().start("main", "chat").is_ok());
        tokio::time::timeout(Duration::from_secs(3), observed)
            .await
            .unwrap()
            .unwrap();
        pages.close("settings", || state.cancel_window("settings"));
        while let Some(result) = callers.join_next().await {
            assert_eq!(result.unwrap().unwrap_err(), "Connection probe cancelled");
        }
        tokio::time::timeout(Duration::from_secs(4), server)
            .await
            .unwrap()
            .unwrap();
        assert!(state.admit(&pages, "second", &second, "extra").is_ok());
    }
}
