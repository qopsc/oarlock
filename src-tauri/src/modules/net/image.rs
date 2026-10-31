//! Remote images for the Markdown preview.
//!
//! The webview's CSP loads no remote images: AI chat Markdown renders in the
//! same webview, and an image URL in a prompt-injected answer would leak data
//! without a click. A file the user opened in the preview fetches its https
//! images here instead, under the same rules as the AI proxy: public
//! addresses only, the resolver pinned to the classified addresses, and every
//! redirect hop validated again.

use super::stream::{AiStreamState, StreamLease};
use futures_util::future::{AbortRegistration, Abortable};
use reqwest::header::{HeaderMap, ACCEPT, CONTENT_TYPE, LOCATION};
use tauri::ipc::{Channel, Response};
use tauri::{Manager, State, WebviewWindow};

/// Separate ownership from AI/MCP streams, with no new image-admission policy.
#[derive(Default)]
pub struct ImageRequests(AiStreamState);
impl ImageRequests {
    pub fn cancel_window(&self, owner: &str) {
        self.0.cancel_window(owner);
    }
    fn start(&self, owner: &str, id: &str) -> Result<(StreamLease, AbortRegistration), String> {
        self.0.start_bounded(owner, id, usize::MAX)
    }
}

async fn load_owned(
    ticket: (StreamLease, AbortRegistration),
    load: impl std::future::Future<Output = Result<Vec<u8>, String>>,
) -> Result<Option<Vec<u8>>, String> {
    let (lease, registration) = ticket;
    let result = Abortable::new(load, registration).await;
    drop(lease);
    match result {
        Ok(result) => result.map(Some),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn markdown_remote_image(
    window: WebviewWindow,
    state: State<'_, ImageRequests>,
    pages: State<'_, super::page::NetworkPages>,
    page_generation: String,
    url: String,
    request_id: String,
    on_event: Channel<Response>,
) -> Result<(), String> {
    if window
        .app_handle()
        .get_webview_window(window.label())
        .is_none()
    {
        return Err("Image request window is closed".into());
    }
    let url = validate_image_url(&url)?;
    // Synchronous registration: no filesystem/network wait before ownership.
    let ticket = pages.with_page(window.label(), &page_generation, || {
        state.start(window.label(), &request_id)
    })?;
    tauri::async_runtime::spawn(async move {
        match load_owned(ticket, fetch_image(url)).await {
            Ok(Some(bytes)) => {
                let _ = on_event.send(Response::new(bytes));
            }
            Ok(None) => (),
            Err(error) => {
                let _ = on_event.send(super::stream_packet(1, error.as_bytes()));
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn markdown_remote_image_cancel(
    window: WebviewWindow,
    state: State<'_, ImageRequests>,
    pages: State<'_, super::page::NetworkPages>,
    page_generation: String,
    request_id: String,
) -> Result<(), String> {
    pages.with_page(window.label(), &page_generation, || {
        state.0.cancel(window.label(), &request_id);
        Ok(())
    })
}

use super::clients::{client_for, Profile};
use super::{classify_and_collect_safe_ips, validate_url};

const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

fn validate_image_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = validate_url(url, false)?;
    if parsed.scheme() != "https" {
        return Err("only https images are loaded".into());
    }
    Ok(parsed)
}

/// The response's image type, without parameters. Anything else (an HTML
/// error page, a script) is refused.
fn image_content_type(headers: &HeaderMap) -> Result<String, String> {
    let value = headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .ok_or("response has no content type")?;
    let mime = value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !mime.starts_with("image/") || mime.len() > 255 {
        return Err(format!("not an image: {mime}"));
    }
    Ok(mime)
}

/// `[0 success][u8 type length][type][image bytes]`: one binary channel result.
fn encode_image(mime: &str, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + mime.len() + body.len());
    out.push(0);
    out.push(mime.len() as u8);
    out.extend_from_slice(mime.as_bytes());
    out.extend_from_slice(body);
    out
}

async fn fetch_image(url: reqwest::Url) -> Result<Vec<u8>, String> {
    super::deadline::within(
        std::time::Duration::from_secs(20),
        "Preview image",
        fetch_image_inner(url),
    )
    .await
}

async fn fetch_image_inner(mut url: reqwest::Url) -> Result<Vec<u8>, String> {
    for _ in 0..=MAX_REDIRECTS {
        let host = url.host_str().ok_or("missing host")?.to_string();
        let safe_ips = classify_and_collect_safe_ips(&host, false).await?;
        let client = client_for(Profile::Fetch, &host, &safe_ips, false)?;
        let mut response = client
            .get(url.clone())
            .header(ACCEPT, "image/*")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("redirect without a location")?;
            let next = url.join(location).map_err(|e| e.to_string())?;
            url = validate_image_url(next.as_str())?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        let mime = image_content_type(response.headers())?;
        if response
            .content_length()
            .is_some_and(|len| len > MAX_IMAGE_BYTES as u64)
        {
            return Err("image is too large".into());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if body.len() + chunk.len() > MAX_IMAGE_BYTES {
                return Err("image is too large".into());
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(encode_image(&mime, &body));
    }
    Err("too many redirects".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    fn headers(content_type: &str) -> HeaderMap {
        let mut map = HeaderMap::new();
        map.insert(CONTENT_TYPE, HeaderValue::from_str(content_type).unwrap());
        map
    }

    #[test]
    fn only_https_urls_without_credentials_are_fetched() {
        assert!(validate_image_url("https://img.shields.io/badge/a-b-c").is_ok());
        assert!(validate_image_url("http://example.com/a.png").is_err());
        assert!(validate_image_url("https://user:pw@example.com/a.png").is_err());
        assert!(validate_image_url("https://metadata.google.internal/a").is_err());
        assert!(validate_image_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn only_image_responses_are_accepted() {
        assert_eq!(
            image_content_type(&headers("image/png")).unwrap(),
            "image/png"
        );
        assert_eq!(
            image_content_type(&headers("Image/SVG+XML; charset=utf-8")).unwrap(),
            "image/svg+xml"
        );
        assert!(image_content_type(&headers("text/html")).is_err());
        assert!(image_content_type(&HeaderMap::new()).is_err());
    }

    #[test]
    fn encodes_the_type_ahead_of_the_bytes() {
        assert_eq!(
            encode_image("image/png", &[1, 2]),
            [&[0u8, 9][..], b"image/png", &[1, 2]].concat()
        );
    }

    #[tokio::test]
    async fn cancellation_before_poll_prevents_io_and_releases_registration() {
        let state = ImageRequests::default();
        let ticket = state.start("main", "image").unwrap();
        assert!(state.start("main", "image").is_err());
        state.0.cancel("main", "image");
        let polled = std::sync::atomic::AtomicBool::new(false);
        let result = load_owned(ticket, async {
            polled.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(vec![1])
        })
        .await
        .unwrap();
        assert!(result.is_none());
        assert!(!polled.load(std::sync::atomic::Ordering::SeqCst));
        assert!(state.start("main", "image").is_ok());
    }

    #[tokio::test]
    async fn cancelling_one_window_does_not_cancel_another_windows_image() {
        let state = ImageRequests::default();
        let first = state.start("main", "image").unwrap();
        let other = state.start("w-a", "image").unwrap();
        state.cancel_window("main");
        assert!(load_owned(first, std::future::pending())
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            load_owned(other, async { Ok(vec![7]) }).await.unwrap(),
            Some(vec![7])
        );
        assert!(state.start("w-a", "image").is_ok());
    }

    #[tokio::test]
    async fn closing_the_owner_drops_an_in_progress_http_body() {
        use std::time::Duration;
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/image", listener.local_addr().unwrap());
        let (ready, started) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let mut request = Vec::new();
            while !request.windows(4).any(|v| v == b"\r\n\r\n") {
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&buffer[..n]);
            }
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 100\r\nConnection: close\r\n\r\nx").await.unwrap();
            ready.send(()).unwrap();
            let read = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut buffer))
                .await
                .expect("cancelled request retained its socket");
            assert!(read.is_err() || read.unwrap() == 0);
        });
        let state = ImageRequests::default();
        let ticket = state.start("main", "image").unwrap();
        let client = client_for(
            Profile::Fetch,
            "127.0.0.1",
            &["127.0.0.1".parse().unwrap()],
            true,
        )
        .unwrap();
        // Local HTTP is only the transport fixture; production URL validation
        // remains HTTPS-only and is covered separately above.
        let download = tokio::spawn(load_owned(ticket, async move {
            client
                .get(url)
                .send()
                .await
                .map_err(|e| e.to_string())?
                .bytes()
                .await
                .map(|b| b.to_vec())
                .map_err(|e| e.to_string())
        }));
        tokio::time::timeout(Duration::from_secs(3), started)
            .await
            .unwrap()
            .unwrap();
        state.cancel_window("main");
        assert!(download.await.unwrap().unwrap().is_none());
        server.await.unwrap();
        assert!(state.start("main", "image").is_ok());
    }
}
