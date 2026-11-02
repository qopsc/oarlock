mod common;

use common::GitRepoFixture;
use oarlock_lib::modules::git::operations;
use std::process::Command;

fn output(fixture: &GitRepoFixture, args: &[&str]) -> String {
    let mut command = Command::new("git");
    command.args(args).current_dir(&fixture.repo_path);
    common::isolate_git_environment(&mut command);
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

#[test]
fn nested_editor_base_reports_a_missing_blob_but_not_an_untracked_file() {
    let fixture = GitRepoFixture::new();
    fixture.write_file("src/tracked.txt", "committed");
    fixture.write_file("src/new.txt", "untracked");
    fixture.run_git(&["add", "src/tracked.txt"]);
    fixture.run_git(&["commit", "-qm", "first"]);
    let file = fixture
        .repo_path
        .join("src/tracked.txt")
        .to_string_lossy()
        .to_string();
    let new = fixture
        .repo_path
        .join("src/new.txt")
        .to_string_lossy()
        .to_string();
    assert_eq!(
        operations::file_base(&fixture.registry, &new, &fixture.workspace).unwrap(),
        None
    );
    let blob = output(&fixture, &["rev-parse", "HEAD:src/tracked.txt"]);
    std::fs::remove_file(
        fixture
            .repo_path
            .join(".git/objects")
            .join(&blob[..2])
            .join(&blob[2..]),
    )
    .unwrap();
    assert!(operations::file_base(&fixture.registry, &file, &fixture.workspace).is_err());
}

#[test]
fn history_distinguishes_an_unborn_head_from_a_broken_revision() {
    let fixture = GitRepoFixture::new();
    assert!(operations::log(
        &fixture.registry,
        &fixture.repo_str(),
        10,
        0,
        None,
        &fixture.workspace
    )
    .unwrap()
    .is_empty());
    fixture.run_git(&["commit", "-q", "--allow-empty", "-m", "first"]);
    assert!(operations::log(
        &fixture.registry,
        &fixture.repo_str(),
        10,
        0,
        Some(&"f".repeat(40)),
        &fixture.workspace
    )
    .is_err());
    let commit = output(&fixture, &["rev-parse", "HEAD"]);
    std::fs::remove_file(
        fixture
            .repo_path
            .join(".git/objects")
            .join(&commit[..2])
            .join(&commit[2..]),
    )
    .unwrap();
    assert!(operations::log(
        &fixture.registry,
        &fixture.repo_str(),
        10,
        0,
        None,
        &fixture.workspace
    )
    .is_err());
}

#[test]
fn normal_unborn_detached_and_no_upstream_cases_remain_valid() {
    let fixture = GitRepoFixture::new();
    let info = operations::resolve_repo(&fixture.registry, &fixture.repo_str(), &fixture.workspace)
        .unwrap()
        .unwrap();
    assert_eq!(info.branch, "main");
    assert!(info.upstream.is_none());
    fixture.run_git(&["commit", "-q", "--allow-empty", "-m", "first"]);
    fixture.run_git(&["switch", "--detach", "-q"]);
    let info = operations::resolve_repo(&fixture.registry, &fixture.repo_str(), &fixture.workspace)
        .unwrap()
        .unwrap();
    assert!(info.is_detached);
    assert!(info.upstream.is_none());
    assert!(operations::remote_url(
        &fixture.registry,
        &fixture.repo_str(),
        "absent",
        &fixture.workspace
    )
    .unwrap()
    .is_none());
}

#[test]
fn invalid_upstream_configuration_is_an_error_not_a_missing_upstream() {
    let fixture = GitRepoFixture::new();
    fixture.run_git(&["commit", "-q", "--allow-empty", "-m", "first"]);
    fixture.run_git(&["config", "branch.main.remote", "missing-remote"]);
    fixture.run_git(&["config", "branch.main.merge", "refs/heads/main"]);
    assert!(
        operations::resolve_repo(&fixture.registry, &fixture.repo_str(), &fixture.workspace)
            .is_err()
    );
}

#[test]
fn malformed_gitfile_is_not_reported_as_an_absent_repository() {
    let root = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(root.path()).unwrap();
    std::fs::write(
        root.join(".git"),
        "gitdir: /definitely-not-an-oarlock-repository\n",
    )
    .unwrap();
    let registry = oarlock_lib::modules::workspace::WorkspaceRegistry::default();
    registry.authorize(&root).unwrap();
    assert!(operations::resolve_repo(
        &registry,
        &root.to_string_lossy(),
        &oarlock_lib::modules::workspace::WorkspaceEnv::Local
    )
    .is_err());
}
