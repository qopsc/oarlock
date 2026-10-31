mod common;
use common::{isolate_git_environment, GitRepoFixture};
use std::process::Command;

#[test]
fn git_fixture_ignores_inherited_repository_and_config_overrides() {
    let a = GitRepoFixture::new();
    let b = GitRepoFixture::new();
    let mut command = Command::new("git");
    command.current_dir(&a.repo_path).args(["rev-parse", "--show-toplevel"])
        .env("GIT_DIR", b.repo_path.join(".git"))
        .env("GIT_WORK_TREE", &b.repo_path)
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "core.worktree")
        .env("GIT_CONFIG_VALUE_0", &b.repo_path);
    isolate_git_environment(&mut command);
    let output = command.output().unwrap();
    assert!(output.status.success());
    let reported = std::fs::canonicalize(String::from_utf8(output.stdout).unwrap().trim()).unwrap();
    assert_eq!(reported, a.repo_path);
    assert_ne!(reported, b.repo_path);
}
