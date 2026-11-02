mod common;
use common::GitRepoFixture;
use oarlock_lib::modules::git::operations;

#[cfg(target_os = "linux")]
#[test]
fn status_marks_unrepresentable_filenames_unreadable_and_keeps_the_rest() {
    use std::os::unix::ffi::OsStringExt;
    let fixture = GitRepoFixture::new();
    let path = std::ffi::OsString::from_vec(b"bad-\xff.txt".to_vec());
    std::fs::write(fixture.repo_path.join(path), b"untracked").unwrap();
    fixture.write_file("fine.txt", "ordinary");
    let snapshot = operations::status(&fixture.registry, &fixture.repo_str(), &fixture.workspace)
        .unwrap_or_else(|error| panic!("status must still succeed: {error}"));
    let bad: Vec<_> = snapshot.changed_files.iter().filter(|f| f.unreadable).collect();
    assert_eq!(bad.len(), 1, "exactly the unrepresentable entry is unreadable");
    assert_eq!(bad[0].status_label, "Unreadable name");
    let fine = snapshot.changed_files.iter().find(|f| f.path == "fine.txt");
    assert!(fine.is_some_and(|f| !f.unreadable), "ordinary entry intact");
}

#[test]
fn staged_diff_refuses_a_truncated_historical_blob() {
    let fixture = GitRepoFixture::new();
    fixture.write_file("large.txt", &"x".repeat(2 * 1024 * 1024 + 1024));
    fixture.run_git(&["add", "large.txt"]);
    fixture.run_git(&["commit", "-qm", "large original"]);
    fixture.write_file("large.txt", "short replacement\n");
    fixture.run_git(&["add", "large.txt"]);
    let result = operations::diff_content(
        &fixture.registry, &fixture.repo_str(), "large.txt", true, None, &fixture.workspace,
    );
    let error = match result {
        Ok(_) => panic!("a truncated historical blob must not be displayed as complete"),
        Err(error) => error.to_string(),
    };
    assert!(error.to_ascii_lowercase().contains("truncat"), "{error}");
}

#[test]
fn history_refuses_a_truncated_git_response() {
    let fixture = GitRepoFixture::new();
    let message = fixture.repo_path.join("message.txt");
    std::fs::write(&message, "x".repeat(2 * 1024 * 1024 + 1024)).unwrap();
    fixture.run_git(&["commit", "--allow-empty", "-q", "-F", message.to_str().unwrap()]);
    let result = operations::log(&fixture.registry, &fixture.repo_str(), 10, 0, None, &fixture.workspace);
    let error = match result {
        Ok(_) => panic!("a truncated history response must not be displayed as complete"),
        Err(error) => error.to_string(),
    };
    assert!(error.to_ascii_lowercase().contains("truncat"), "{error}");
}
