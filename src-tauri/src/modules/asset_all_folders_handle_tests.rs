use super::*;

fn request(path: &Path, method: Method) -> http::Request<Vec<u8>> {
    let encoded: String = path
        .to_string_lossy()
        .bytes()
        .map(|byte| format!("%{byte:02X}"))
        .collect();
    http::Request::builder()
        .method(method)
        .uri(format!("{SCHEME}://localhost/{encoded}"))
        .body(Vec::new())
        .unwrap()
}

#[cfg(unix)]
#[test]
fn replaced_file_after_authorization_does_not_change_opened_content() {
    use std::os::unix::fs::symlink;
    let tmp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let public = root.join("public.txt");
    let outside = root.join("outside.txt");
    std::fs::write(&public, "public").unwrap();
    std::fs::write(&outside, "private").unwrap();
    let response = respond(
        &request(&public, Method::GET),
        "tauri://localhost",
        |actual| {
            assert_eq!(actual, public);
            std::fs::rename(&public, root.join("original.txt")).unwrap();
            symlink(&outside, &public).unwrap();
            true
        },
    );
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.body(), b"public");
}

#[cfg(unix)]
#[test]
fn parent_replacement_after_open_does_not_redirect_the_response() {
    use std::os::unix::fs::symlink;
    let tmp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let parent = root.join("allowed");
    let outside = root.join("outside");
    std::fs::create_dir(&parent).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(parent.join("file"), "public").unwrap();
    std::fs::write(outside.join("file"), "private").unwrap();
    let response = respond(
        &request(&parent.join("file"), Method::GET),
        "tauri://localhost",
        |actual| {
            assert!(actual.starts_with(&parent));
            std::fs::rename(&parent, root.join("original")).unwrap();
            symlink(&outside, &parent).unwrap();
            true
        },
    );
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.body(), b"public");
}

#[cfg(unix)]
#[test]
fn symlinks_are_authorized_by_the_opened_target() {
    use std::os::unix::fs::symlink;
    let tmp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let public = root.join("public");
    let secret = root.join(".secret");
    std::fs::write(&public, "public").unwrap();
    std::fs::write(&secret, "secret").unwrap();
    let link = root.join("link");
    symlink(&public, &link).unwrap();
    let allowed = |actual: &Path| actual == public;
    assert_eq!(
        respond(&request(&link, Method::GET), "tauri://localhost", allowed).body(),
        b"public"
    );
    std::fs::remove_file(&link).unwrap();
    symlink(&secret, &link).unwrap();
    assert_eq!(
        respond(&request(&link, Method::GET), "tauri://localhost", allowed).status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        respond(
            &request(&link, Method::GET),
            "tauri://localhost",
            |actual| serves(actual, false, true)
        )
        .status(),
        StatusCode::FORBIDDEN
    );
}

#[cfg(unix)]
#[test]
fn fifo_is_refused_without_waiting_for_a_writer() {
    use std::os::unix::ffi::OsStrExt;
    let tmp = tempfile::tempdir().unwrap();
    let fifo = tmp.path().join("pipe");
    let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let response = respond(&request(&fifo, Method::GET), "tauri://localhost", |_| true);
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[test]
fn revoked_permission_refuses_an_opened_file_and_head_has_no_body() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("file.txt");
    std::fs::write(&file, "visible").unwrap();
    assert_eq!(
        respond(&request(&file, Method::GET), "tauri://localhost", |_| false).status(),
        StatusCode::FORBIDDEN
    );
    let head = respond(&request(&file, Method::HEAD), "tauri://localhost", |_| true);
    assert_eq!(head.status(), StatusCode::OK);
    assert!(head.body().is_empty());
    assert_eq!(head.headers()[header::CONTENT_LENGTH], "7");
}

#[cfg(unix)]
#[test]
fn replacements_before_open_are_authorized_as_their_actual_targets() {
    use std::os::unix::fs::symlink;
    let tmp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let allowed = root.join("allowed");
    let outside = root.join("outside");
    std::fs::create_dir(&allowed).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("secret"), "private").unwrap();
    symlink(outside.join("secret"), allowed.join("file")).unwrap();
    let check = |actual: &Path| actual.starts_with(&allowed);
    assert_eq!(
        respond(
            &request(&allowed.join("file"), Method::GET),
            "tauri://localhost",
            check
        )
        .status(),
        StatusCode::FORBIDDEN
    );
    std::fs::rename(&allowed, root.join("original")).unwrap();
    symlink(&outside, &allowed).unwrap();
    assert_eq!(
        respond(
            &request(&allowed.join("secret"), Method::GET),
            "tauri://localhost",
            check
        )
        .status(),
        StatusCode::FORBIDDEN
    );
}

#[test]
fn changed_setting_is_used_for_each_new_request_and_foreign_origins_are_rejected() {
    let tmp = tempfile::Builder::new()
        .prefix("oarlock-preview-")
        .tempdir()
        .unwrap();
    let file = tmp.path().join("image.png");
    std::fs::write(&file, "visible").unwrap();
    let registry = WorkspaceRegistry::default();
    registry.set_all_folders(Origin::App, true);
    let authorize = |path: &Path| serves(path, false, app_reaches_all(Some(&registry)));
    assert_eq!(
        respond(&request(&file, Method::GET), "tauri://localhost", authorize).status(),
        StatusCode::OK
    );
    registry.set_all_folders(Origin::App, false);
    assert_eq!(
        respond(&request(&file, Method::GET), "tauri://localhost", authorize).status(),
        StatusCode::FORBIDDEN
    );
    let origins = AllowedOrigins::for_app(None, false, false);
    assert!(origins.check(Some(b"https://example.org")).is_none());
    assert_eq!(
        &*origins.check(Some(b"tauri://localhost")).unwrap(),
        "tauri://localhost"
    );
}
