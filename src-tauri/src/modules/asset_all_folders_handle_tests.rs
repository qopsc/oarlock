use super::*;

#[test]
fn oversized_whole_preview_is_refused_before_buffering() {
    use std::io::Write;
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("large.pdf");
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(b"%PDF-1.7\n").unwrap();
    file.set_len(50 * 1024 * 1024 + 1).unwrap();
    let response = respond(&request(&path, Method::GET), "tauri://localhost", |_| true);
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(response.body().len() < 1024);
}

#[test]
fn oversized_image_is_refused_even_for_a_range_request() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("large.png");
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(50 * 1024 * 1024 + 1).unwrap();
    let mut request = request(&path, Method::GET);
    request.headers_mut().insert(header::RANGE, HeaderValue::from_static("bytes=0-100"));
    let response = respond(&request, "tauri://localhost", |_| true);
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[test]
fn large_video_keeps_existing_bounded_range_playback() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("large.mp4");
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(50 * 1024 * 1024 + 1).unwrap();
    let mut request = request(&path, Method::GET);
    request.headers_mut().insert(header::RANGE, HeaderValue::from_static("bytes=0-15"));
    let response = respond(&request, "tauri://localhost", |_| true);
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.body().len(), 16);
}

#[test]
fn preview_admission_is_bounded_and_releases_capacity() {
    let permits: Vec<_> = (0..MAX_PENDING_PREVIEWS)
        .map(|_| preview_admission().clone().try_acquire_owned().unwrap())
        .collect();
    assert!(preview_admission().clone().try_acquire_owned().is_err());
    drop(permits);
    assert!(preview_admission().clone().try_acquire_owned().is_ok());
}

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

#[test]
fn pdf_preview_refuses_html_and_keeps_valid_pdf_content() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("document.PDF");
    let fake = b"<!DOCTYPE HTML><script>window.evidence = true</script>\0";
    std::fs::write(&path, fake).unwrap();
    let denied = respond(&request(&path, Method::GET), "tauri://localhost", |_| true);
    assert_eq!(denied.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(denied.headers()[header::CONTENT_TYPE], "text/plain");
    assert!(!denied.body().windows(7).any(|chunk| chunk == b"<script"));
    assert!(denied.headers()[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap()
        .contains("sandbox"));
    let head = respond(&request(&path, Method::HEAD), "tauri://localhost", |_| true);
    assert_eq!(head.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert!(head.body().is_empty());
    let mut ranged = request(&path, Method::GET);
    ranged
        .headers_mut()
        .insert(header::RANGE, HeaderValue::from_static("bytes=0-8"));
    assert_eq!(
        respond(&ranged, "tauri://localhost", |_| true).status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );

    let pdf = b"%PDF-1.4\n% valid PDF header\n";
    std::fs::write(&path, pdf).unwrap();
    let allowed = respond(&request(&path, Method::GET), "tauri://localhost", |_| true);
    assert_eq!(allowed.status(), StatusCode::OK);
    assert_eq!(allowed.headers()[header::CONTENT_TYPE], "application/pdf");
    assert_eq!(allowed.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(allowed.body(), pdf);
}

#[test]
fn pdf_html_polyglot_is_never_served_as_executable_html() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("polyglot.pdf");
    std::fs::write(
        &path,
        b"<!DOCTYPE HTML><script>evil()</script><!--%PDF-1.4-->\0",
    )
    .unwrap();
    let response = respond(&request(&path, Method::GET), "tauri://localhost", |_| true);
    assert!(
        response.status() == StatusCode::UNSUPPORTED_MEDIA_TYPE
            || (response.status() == StatusCode::OK
                && response.headers()[header::CONTENT_TYPE] == "application/pdf"
                && response.headers()[header::X_CONTENT_TYPE_OPTIONS] == "nosniff")
    );
}

#[cfg(unix)]
#[test]
fn pdf_alias_cannot_open_html_through_a_symlink() {
    use std::os::unix::fs::symlink;
    let tmp = tempfile::tempdir().unwrap();
    // The target name must not override its actual PDF contents.
    let html = tmp.path().join("payload.svg");
    let alias = tmp.path().join("document.pdf");
    std::fs::write(&html, b"<!DOCTYPE HTML><script>evil()</script>\0").unwrap();
    symlink(&html, &alias).unwrap();
    let response = respond(&request(&alias, Method::GET), "tauri://localhost", |_| true);
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    std::fs::write(&html, b"%PDF-1.4\n% valid PDF header\n").unwrap();
    let response = respond(&request(&alias, Method::GET), "tauri://localhost", |_| true);
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/pdf");
}

const HTML: &[u8] = b"<!DOCTYPE html><html><script>fetch('x')</script></html>";
const PNG: &[u8] =
    b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89";

fn assert_inert(response: &http::Response<Vec<u8>>) {
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "application/octet-stream"
    );
    assert_eq!(response.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert!(response.headers()[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap()
        .contains("sandbox"));
}

#[test]
fn html_bytes_are_never_served_as_a_document_whatever_the_name() {
    let tmp = tempfile::tempdir().unwrap();
    for name in ["notes.md", "logo.png", "README", "page.html", "clip.mp4", "a.js"] {
        let path = tmp.path().join(name);
        std::fs::write(&path, HTML).unwrap();
        let response = respond(&request(&path, Method::GET), "tauri://localhost", |_| true);
        assert_eq!(response.status(), StatusCode::OK, "{name}");
        assert_inert(&response);
        let head = respond(&request(&path, Method::HEAD), "tauri://localhost", |_| true);
        assert_inert(&head);
    }
}

#[test]
fn image_media_and_pdf_keep_their_types_with_nosniff() {
    let tmp = tempfile::tempdir().unwrap();
    let png = tmp.path().join("pic.png");
    std::fs::write(&png, PNG).unwrap();
    let response = respond(&request(&png, Method::GET), "tauri://localhost", |_| true);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(response.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");

    let svg = tmp.path().join("pic.svg");
    std::fs::write(
        &svg,
        b"<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>",
    )
    .unwrap();
    let response = respond(&request(&svg, Method::GET), "tauri://localhost", |_| true);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/svg+xml");
    assert!(response.headers()[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap()
        .contains("sandbox"));

    let pdf = tmp.path().join("doc.pdf");
    std::fs::write(&pdf, b"%PDF-1.4\n").unwrap();
    let response = respond(&request(&pdf, Method::GET), "tauri://localhost", |_| true);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/pdf");
    assert_eq!(response.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
}

#[test]
fn a_png_named_file_holding_html_is_inert_even_for_a_range() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("evil.png");
    std::fs::write(&path, HTML).unwrap();
    let mut request = request(&path, Method::GET);
    request
        .headers_mut()
        .insert(header::RANGE, HeaderValue::from_static("bytes=0-9"));
    let ranged = respond(&request, "tauri://localhost", |_| true);
    assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
    assert_inert(&ranged);
}

#[test]
fn a_path_outside_every_scope_is_refused_without_being_opened() {
    use std::cell::Cell;
    let tmp = tempfile::tempdir().unwrap();
    let outside = tmp.path().join("pic.png");
    std::fs::write(&outside, PNG).unwrap();
    let opened = Cell::new(false);
    let response = respond_with(
        &request(&outside, Method::GET),
        "tauri://localhost",
        |path| serves(path, false, false),
        |_| {
            opened.set(true);
            true
        },
    );
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(!opened.get(), "the handle was never authorized, so never opened");

    let dot = tmp.path().join(".ssh").join("id.png");
    let response = respond_with(
        &request(&dot, Method::GET),
        "tauri://localhost",
        |path| serves(path, false, true),
        |_| {
            opened.set(true);
            true
        },
    );
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(!opened.get());
}

#[test]
fn parent_components_are_refused_before_the_open() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("a").join("..").join("pic.png");
    std::fs::create_dir(tmp.path().join("a")).unwrap();
    std::fs::write(tmp.path().join("pic.png"), PNG).unwrap();
    let response = respond_with(
        &request(&path, Method::GET),
        "tauri://localhost",
        |_| true,
        |_| true,
    );
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[test]
fn a_scoped_path_is_still_judged_again_on_the_opened_handle() {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("pic.png");
    std::fs::write(&file, PNG).unwrap();
    let response = respond_with(
        &request(&file, Method::GET),
        "tauri://localhost",
        |_| true,
        |_| false,
    );
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[test]
fn only_the_current_page_of_the_window_may_ask() {
    let pages = NetworkPages::default();
    assert!(!page_admits(&pages, "main", Some("access=1&t=abc")), "no page");
    pages.begin("main", || {}).unwrap();
    assert!(!page_admits(&pages, "main", Some("t=abc")), "not delivered yet");
    let token = pages.finish("main").unwrap();
    assert!(page_admits(&pages, "main", Some(&format!("access=1&t={token}"))));
    assert!(page_admits(&pages, "main", Some(&format!("t={token}&access=0"))));
    assert!(!page_admits(&pages, "main", None), "a frame with no token");
    assert!(!page_admits(&pages, "main", Some("access=1")));
    assert!(!page_admits(&pages, "main", Some("t=")));
    assert!(!page_admits(&pages, "main", Some("t=guess")));
    assert!(!page_admits(&pages, "w-2", Some(&format!("t={token}"))), "another window");
    pages.begin("main", || {}).unwrap();
    assert!(!page_admits(&pages, "main", Some(&format!("t={token}"))), "reloaded");
}
