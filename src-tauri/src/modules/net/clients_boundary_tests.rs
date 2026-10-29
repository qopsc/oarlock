//! Local-only network boundary regressions. Payloads and credentials are synthetic.
use super::clients::{client_for, Profile};
use std::{collections::HashMap, net::IpAddr, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

async fn serve_once(listener: TcpListener, response: String) -> Vec<u8> {
    serve(&listener, &response).await
}

async fn serve(listener: &TcpListener, response: &str) -> Vec<u8> {
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut bytes = Vec::new();
    loop {
        let mut buffer = [0u8; 4096];
        let n = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut buffer))
            .await
            .unwrap()
            .unwrap();
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..n]);
        assert!(bytes.len() < 32 * 1024);
        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
            let length = headers
                .lines()
                .find_map(|line| {
                    line.strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                break;
            }
        }
    }
    socket.write_all(response.as_bytes()).await.unwrap();
    bytes
}

#[tokio::test]
async fn redirects_do_not_forward_prompt_or_api_key_to_another_origin() {
    for status in [301, 302, 303, 307, 308] {
        check_cross_origin_redirect(status).await;
    }
}

async fn check_cross_origin_redirect(status: u16) {
    let first = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let source = format!("http://{}/v1/chat", first.local_addr().unwrap());
    let destination = format!("http://{}/collect", second.local_addr().unwrap());
    let first_task = tokio::spawn(serve_once(first, format!("HTTP/1.1 {status} Redirect\r\nLocation: {destination}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")));
    let mut second_task = tokio::spawn(serve_once(
        second,
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".into(),
    ));
    let url = super::validate_url(&source, true).unwrap();
    let host = url.host_str().unwrap();
    let ips = super::classify_and_collect_safe_ips(host, true)
        .await
        .unwrap();
    let client = client_for(Profile::Stream, host, &ips, true).unwrap();
    let request = super::build_request(
        &client,
        "POST",
        url,
        Some(HashMap::from([(
            "x-api-key".into(),
            "synthetic-review-key".into(),
        )])),
        Some(bytes::Bytes::from_static(b"synthetic private prompt")),
    )
    .unwrap();
    let response = request.timeout(Duration::from_secs(3)).send().await;
    first_task.await.unwrap();
    let forwarded = match tokio::time::timeout(Duration::from_millis(100), &mut second_task).await {
        Ok(result) => Some(result.unwrap()),
        Err(_) => {
            second_task.abort();
            None
        }
    };
    assert!(
        forwarded.is_none(),
        "redirect forwarded synthetic key/prompt: {}",
        String::from_utf8_lossy(&forwarded.unwrap_or_default())
    );
    let error = super::error_chain(&response.unwrap_err());
    assert!(error.contains("original origin"), "{error}");
}

#[test]
fn inherited_proxy_cannot_override_the_pinned_destination() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let direct = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination = format!(
            "http://pinned.invalid:{}/",
            direct.local_addr().unwrap().port()
        );
        let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
        let direct_task = tokio::spawn(async move {
            for _ in 0..4 {
                serve(
                    &direct,
                    "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\npinned",
                )
                .await;
            }
        });
        let proxy_task = tokio::spawn(serve_once(
            proxy,
            "HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nuntrusted".into(),
        ));
        let child = tokio::task::spawn_blocking(move || {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "modules::net::clients_boundary_tests::proxy_probe_child",
                    "--nocapture",
                ])
                .env("OARLOCK_NETWORK_PROBE_URL", destination)
                .env("http_proxy", &proxy_url)
                .env("HTTP_PROXY", &proxy_url);
            for name in [
                "HTTPS_PROXY",
                "https_proxy",
                "ALL_PROXY",
                "all_proxy",
                "NO_PROXY",
                "no_proxy",
            ] {
                command.env_remove(name);
            }
            command.output().unwrap()
        })
        .await
        .unwrap();
        direct_task.abort();
        proxy_task.abort();
        assert!(
            child.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&child.stdout),
            String::from_utf8_lossy(&child.stderr)
        );
    });
}

#[tokio::test]
async fn proxy_probe_child() {
    let Ok(url) = std::env::var("OARLOCK_NETWORK_PROBE_URL") else {
        return;
    };
    // The resolver override is intentionally loopback so the entire test stays
    // local. The proxy must not replace the address the caller already checked.
    for profile in [Profile::Stream, Profile::Ping, Profile::Fetch, Profile::Mcp] {
        let client = client_for(
            profile,
            "pinned.invalid",
            &["127.0.0.1".parse::<IpAddr>().unwrap()],
            false,
        )
        .unwrap();
        let body = client
            .get(&url)
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(
            body, "pinned",
            "{profile:?} bypassed its pinned destination"
        );
    }
}

#[tokio::test]
async fn same_origin_redirect_keeps_the_body_and_headers() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/first", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        serve(&listener, "HTTP/1.1 307 Temporary Redirect\r\nLocation: /second\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
        serve(
            &listener,
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
        )
        .await
    });
    let client = client_for(
        Profile::Stream,
        "127.0.0.1",
        &["127.0.0.1".parse().unwrap()],
        true,
    )
    .unwrap();
    let response = client
        .post(url)
        .header("x-api-key", "synthetic-review-key")
        .body("synthetic private prompt")
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .unwrap();
    assert_eq!(response.text().await.unwrap(), "ok");
    let request = String::from_utf8(server.await.unwrap()).unwrap();
    assert!(request.starts_with("POST /second "));
    assert!(request.contains("x-api-key: synthetic-review-key"));
    assert!(request.ends_with("synthetic private prompt"));
}
