//! Local webview smoke test: native generation delivery and reload retirement.
//! Run after `bun build src/lib/networkPage.ts --target=browser
//! --outfile=/tmp/oarlock-network-page.js`, then
//! `cargo run --locked --example network_page_probe` from src-tauri.
//! Uses an invisible isolated window and a loopback fixture; no app stores/keys.
use oarlock_lib::modules::net::page::{self, NetworkPages};
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::Duration,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn main() {
    let js = std::fs::read("/tmp/oarlock-network-page.js")
        .expect("build the frontend probe module first");
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", server.local_addr().unwrap());
    let (ready, handle) = std::sync::mpsc::channel::<tauri::AppHandle>();
    std::thread::spawn(move || {
        let app = handle.recv().unwrap();
        let timeout_app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(20));
            eprintln!("network page probe timed out");
            timeout_app.exit(1);
        });
        let mut old = None;
        for connection in server.incoming() {
            let mut socket = connection.unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            loop {
                let mut buffer = [0u8; 4096];
                let n = socket.read(&mut buffer).unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..n]);
                if request.windows(4).any(|v| v == b"\r\n\r\n") {
                    break;
                }
                assert!(request.len() < 16384);
            }
            let first = std::str::from_utf8(&request)
                .unwrap()
                .lines()
                .next()
                .unwrap();
            let path = first.split_whitespace().nth(1).unwrap();
            let (kind, body) = if path == "/page.js" {
                ("text/javascript", js.clone())
            } else if let Some(token) = path.strip_prefix("/report?token=") {
                let pages = app.state::<NetworkPages>();
                let valid = pages.with_page("network-probe", token, || Ok(())).is_ok();
                let retired = old.as_ref().is_none_or(|previous: &String| {
                    pages
                        .with_page("network-probe", previous, || Ok(()))
                        .is_err()
                });
                if !valid || !retired {
                    eprintln!("generation validation failed: current={valid}, retired={retired}");
                    app.exit(1);
                }
                let final_report = old.is_some();
                old = Some(token.to_owned());
                let response = if final_report { "done" } else { "reload" };
                if final_report {
                    println!("PASS: native delivery, generation rotation, and stale-page rejection in real webview");
                    app.exit(0);
                }
                ("text/plain", response.as_bytes().to_vec())
            } else {
                ("text/html", br#"<!doctype html><script type="module">import {networkPage} from '/page.js'; networkPage(new AbortController().signal).then(token => fetch('/report?token='+token)).then(r=>r.text()).then(result=>{if(result==='reload')location.reload()}).catch(e=>console.error(e));</script>"#.to_vec())
            };
            let header = format!("HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = socket
                .write_all(header.as_bytes())
                .and_then(|_| socket.write_all(&body));
        }
    });
    let mut context = tauri::generate_context!(test = true);
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "consulting.quantumops.oarlock.network-probe".into();
    tauri::Builder::default()
        .manage(NetworkPages::default())
        .on_page_load(|webview, payload| page::on_load(webview, payload.event()))
        .setup(move |app| {
            ready.send(app.handle().clone()).unwrap();
            WebviewWindowBuilder::new(
                app,
                "network-probe",
                WebviewUrl::External(url.parse().unwrap()),
            )
            .visible(false)
            .build()?;
            Ok(())
        })
        .run(context)
        .expect("network page probe runtime");
}
