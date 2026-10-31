mod common;
use common::GitRepoFixture;
use oarlock_lib::modules::git::{ai_diff::staged_diff, operations};

fn read(
    repo: &GitRepoFixture,
) -> oarlock_lib::modules::git::errors::Result<oarlock_lib::modules::git::ai_diff::AiStagedDiff> {
    staged_diff(&repo.registry, &repo.repo_str(), &repo.workspace)
}

#[cfg(unix)]
#[test]
fn ai_snapshot_cannot_follow_git_metadata_into_an_unauthorized_repository() {
    let allowed = GitRepoFixture::new();
    let other = GitRepoFixture::new();
    other.write_file("ordinary.txt", "SYNTHETIC_PRIVATE_OTHER_WORKSPACE\n");
    other.run_git(&["add", "ordinary.txt"]);
    std::fs::rename(
        allowed.repo_path.join(".git"),
        allowed.repo_path.join("original-git"),
    )
    .unwrap();
    std::os::unix::fs::symlink(other.repo_path.join(".git"), allowed.repo_path.join(".git"))
        .unwrap();
    let result = read(&allowed);
    assert!(
        result.is_err(),
        "AI snapshot read unauthorized repository content: {result:?}"
    );
}

#[test]
fn staged_snapshot_excludes_unstaged_content_on_an_unborn_branch() {
    let r = GitRepoFixture::new();
    r.write_file("ordinary.txt", "staged version\n");
    r.run_git(&["add", "."]);
    r.write_file("ordinary.txt", "unstaged version\n");
    let result = read(&r).unwrap();
    assert_eq!(result.paths, ["ordinary.txt"]);
    assert!(result.diff_text.contains("+staged version"));
    assert!(!result.diff_text.contains("unstaged version"));
}

#[test]
fn protected_staged_content_refuses_entire_ai_request_but_not_git_ui() {
    let r = GitRepoFixture::new();
    r.write_file("ordinary.txt", "ordinary\n");
    r.write_file(".env", "API_TOKEN=SYNTHETIC_REVIEW_SECRET\n");
    r.run_git(&["add", "."]);
    assert!(read(&r).unwrap_err().to_string().contains("protected path"));
    assert!(
        operations::diff(&r.registry, &r.repo_str(), None, true, &r.workspace)
            .unwrap()
            .diff_text
            .contains("SYNTHETIC_REVIEW_SECRET")
    );
}

#[test]
fn historical_secret_deletions_and_both_rename_directions_are_refused() {
    for (before, after) in [
        (".env", None),
        (".env", Some("ordinary.txt")),
        ("ordinary.txt", Some(".env")),
        (".ssh/config", Some("config.txt")),
    ] {
        let r = GitRepoFixture::new();
        r.write_file(before, "synthetic secret\n");
        r.run_git(&["add", "."]);
        r.run_git(&["commit", "-qm", "initial"]);
        match after {
            Some(after) => r.run_git(&["mv", before, after]),
            None => r.run_git(&["rm", before]),
        }
        assert!(
            read(&r).unwrap_err().to_string().contains("protected path"),
            "{before} -> {after:?}"
        );
    }
}

#[test]
fn unchanged_secrets_are_not_read_and_safe_rename_is_supported() {
    let r = GitRepoFixture::new();
    r.write_file(".env", "SYNTHETIC_UNCHANGED_SECRET\n");
    r.write_file("old name.txt", "ordinary\n");
    r.run_git(&["add", "."]);
    r.run_git(&["commit", "-qm", "initial"]);
    r.run_git(&["mv", "old name.txt", "new name.txt"]);
    let result = read(&r).unwrap();
    assert_eq!(result.paths, ["new name.txt", "old name.txt"]);
    assert!(!result.diff_text.contains("SYNTHETIC_UNCHANGED_SECRET"));
}

#[test]
fn textconv_and_external_diff_cannot_supply_unchecked_content() {
    let r = GitRepoFixture::new();
    r.write_file(".gitattributes", "*.txt diff=unsafe\n");
    r.write_file("safe.txt", "ordinary\n");
    // Either command would make the request fail if Git attempted to execute it.
    r.run_git(&[
        "config",
        "diff.unsafe.textconv",
        "oarlock-nonexistent-secret-reader",
    ]);
    r.run_git(&[
        "config",
        "diff.external",
        "oarlock-nonexistent-secret-reader",
    ]);
    r.run_git(&["add", "."]);
    assert!(read(&r).unwrap_err().to_string().contains("diff driver"));
}

#[cfg(unix)]
#[test]
fn safe_alias_to_protected_path_is_refused() {
    let r = GitRepoFixture::new();
    r.write_file(".env", "synthetic secret");
    std::os::unix::fs::symlink(".env", r.repo_path.join("ordinary.txt")).unwrap();
    r.run_git(&["add", "ordinary.txt"]);
    assert!(read(&r).unwrap_err().to_string().contains("protected path"));
}

#[test]
fn ai_snapshot_cannot_follow_a_gitfile_into_an_unauthorized_repository() {
    let allowed = GitRepoFixture::new();
    let other = GitRepoFixture::new();
    other.write_file("ordinary.txt", "SYNTHETIC_PRIVATE_OTHER_WORKSPACE\n");
    other.run_git(&["add", "ordinary.txt"]);
    std::fs::rename(
        allowed.repo_path.join(".git"),
        allowed.repo_path.join("original-git"),
    )
    .unwrap();
    std::fs::write(
        allowed.repo_path.join(".git"),
        format!("gitdir: {}\n", other.repo_path.join(".git").display()),
    )
    .unwrap();
    let result = read(&allowed);
    assert!(
        result.is_err(),
        "AI snapshot read unauthorized repository content: {result:?}"
    );
    assert!(
        operations::status(&allowed.registry, &allowed.repo_str(), &allowed.workspace).is_err()
    );
    assert!(
        operations::resolve_repo(&allowed.registry, &allowed.repo_str(), &allowed.workspace)
            .is_err()
    );
    assert!(
        operations::panel_snapshot(&allowed.registry, &allowed.repo_str(), &allowed.workspace)
            .is_err()
    );
    allowed.registry.authorize(&other.repo_path).unwrap();
    assert!(read(&allowed)
        .unwrap()
        .diff_text
        .contains("SYNTHETIC_PRIVATE_OTHER_WORKSPACE"));
}
