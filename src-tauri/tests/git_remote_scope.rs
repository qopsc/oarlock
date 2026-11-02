mod common;
use common::{git_available, GitRepoFixture};
use oarlock_lib::modules::git::operations;

#[test]
fn fetch_ignores_an_unrelated_unauthorized_local_remote() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let selected = GitRepoFixture::new();
    let unrelated = GitRepoFixture::new();
    source.registry.authorize(&selected.repo_path).unwrap();
    source.run_git(&["remote", "add", "origin", &selected.repo_str()]);
    source.run_git(&["remote", "add", "unrelated", &unrelated.repo_str()]);
    if let Err(error) = operations::fetch(&source.registry, &source.repo_str(), &source.workspace) {
        panic!("selected fetch failed: {error}");
    }
}

#[test]
fn fetch_all_checks_other_remotes_that_git_will_use() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let selected = GitRepoFixture::new();
    let unrelated = GitRepoFixture::new();
    source.registry.authorize(&selected.repo_path).unwrap();
    source.run_git(&["remote", "add", "origin", &selected.repo_str()]);
    source.run_git(&["remote", "add", "unrelated", &unrelated.repo_str()]);
    source.run_git(&["config", "fetch.all", "true"]);
    let error =
        operations::fetch(&source.registry, &source.repo_str(), &source.workspace).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("outside the authorized workspace"),
        "{error}"
    );
}

#[test]
fn fetch_checks_only_the_first_configured_url() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let selected = GitRepoFixture::new();
    let unused = GitRepoFixture::new();
    source.registry.authorize(&selected.repo_path).unwrap();
    source.run_git(&["remote", "add", "origin", &selected.repo_str()]);
    source.run_git(&["config", "--add", "remote.origin.url", &unused.repo_str()]);
    if let Err(error) = operations::fetch(&source.registry, &source.repo_str(), &source.workspace) {
        panic!("fetch rejected an unused URL: {error}");
    }
}

#[test]
fn push_checks_every_push_url_for_the_selected_remote() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let selected = GitRepoFixture::new();
    let untrusted = GitRepoFixture::new();
    source.registry.authorize(&selected.repo_path).unwrap();
    source.run_git(&["remote", "add", "origin", &selected.repo_str()]);
    source.run_git(&[
        "config",
        "--add",
        "remote.origin.pushurl",
        &selected.repo_str(),
    ]);
    source.run_git(&[
        "config",
        "--add",
        "remote.origin.pushurl",
        &untrusted.repo_str(),
    ]);
    let error = operations::push(&source.registry, &source.repo_str(), &source.workspace)
        .err()
        .unwrap();
    assert!(
        error
            .to_string()
            .contains("outside the authorized workspace"),
        "{error}"
    );
}

#[test]
fn fetch_rejects_a_selected_url_rewritten_to_an_unauthorized_local_remote() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let untrusted = GitRepoFixture::new();
    source.run_git(&["remote", "add", "origin", "oarlock-test:repo"]);
    source.run_git(&[
        "config",
        &format!("url.{}.insteadOf", untrusted.repo_str()),
        "oarlock-test:repo",
    ]);
    let error =
        operations::fetch(&source.registry, &source.repo_str(), &source.workspace).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("outside the authorized workspace"),
        "{error}"
    );
}

#[test]
fn fetch_all_ignores_a_remote_skipped_by_the_legacy_alias() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let selected = GitRepoFixture::new();
    let skipped = GitRepoFixture::new();
    source.registry.authorize(&selected.repo_path).unwrap();
    source.run_git(&["remote", "add", "origin", &selected.repo_str()]);
    source.run_git(&["remote", "add", "unrelated", &skipped.repo_str()]);
    source.run_git(&["config", "fetch.all", "true"]);
    source.run_git(&["config", "remote.unrelated.skipDefaultUpdate", "true"]);
    operations::fetch(&source.registry, &source.repo_str(), &source.workspace).unwrap();
}

#[test]
fn fetch_rejects_embedded_newline_remote() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let temp = tempfile::tempdir().unwrap();
    let allowed = temp.path().join("allowed");
    let actual = std::path::PathBuf::from(format!("{}\nother", allowed.display()));
    for path in [&allowed, &actual] {
        let status = std::process::Command::new("git")
            .args(["init", "--quiet"])
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }
    source.registry.authorize(&allowed).unwrap();
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(source.repo_path.join("other"))
        .status()
        .unwrap()
        .success());
    source.run_git(&["remote", "add", "origin", actual.to_str().unwrap()]);
    let result = operations::fetch(&source.registry, &source.repo_str(), &source.workspace);
    let error = result.unwrap_err();
    assert!(error.to_string().contains("control character"), "{error}");
}

#[test]
fn selected_urls_with_control_characters_are_refused() {
    if !git_available() {
        return;
    }
    for control in ['\r', '\t', '\x1b', '\x7f'] {
        let source = GitRepoFixture::new();
        let value = format!("https://example.invalid/{control}path");
        source.run_git(&["remote", "add", "origin", &value]);
        let error =
            operations::fetch(&source.registry, &source.repo_str(), &source.workspace).unwrap_err();
        assert!(
            error.to_string().contains("control character"),
            "{control:?}: {error}"
        );
    }
}

#[test]
fn selected_push_urls_with_control_characters_are_refused() {
    if !git_available() {
        return;
    }
    for control in ['\n', '\r', '\t', '\x1b'] {
        let source = GitRepoFixture::new();
        source.run_git(&["remote", "add", "origin", "https://example.invalid/safe"]);
        source.run_git(&[
            "config",
            "remote.origin.pushurl",
            &format!("https://example.invalid/{control}path"),
        ]);
        let error = operations::push(&source.registry, &source.repo_str(), &source.workspace)
            .err()
            .unwrap();
        assert!(
            error.to_string().contains("control character"),
            "{control:?}: {error}"
        );
    }
}

#[test]
fn push_instead_of_is_resolved_before_authorization() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let outside = GitRepoFixture::new();
    source.run_git(&["remote", "add", "origin", "https://example.invalid/safe"]);
    source.run_git(&[
        "config",
        &format!("url.{}.pushInsteadOf", outside.repo_str()),
        "https://example.invalid/safe",
    ]);
    let error = operations::push(&source.registry, &source.repo_str(), &source.workspace)
        .err()
        .unwrap();
    assert!(
        error
            .to_string()
            .contains("outside the authorized workspace"),
        "{error}"
    );
}

#[test]
fn encoded_control_character_in_file_url_is_refused() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    source.run_git(&["remote", "add", "origin", "file:///tmp/oarlock%0Ainvalid"]);
    let error =
        operations::fetch(&source.registry, &source.repo_str(), &source.workspace).unwrap_err();
    assert!(error.to_string().contains("control character"), "{error}");
}

#[test]
fn malformed_nul_in_remote_config_is_refused() {
    use std::io::Write;
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let mut config = std::fs::OpenOptions::new()
        .append(true)
        .open(source.repo_path.join(".git/config"))
        .unwrap();
    config
        .write_all(b"\n[remote \"origin\"]\nurl = /tmp/a\0b\n")
        .unwrap();
    assert!(operations::fetch(&source.registry, &source.repo_str(), &source.workspace).is_err());
}

#[test]
fn push_rewrite_uses_the_longest_matching_prefix() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let outside = GitRepoFixture::new();
    let allowed = GitRepoFixture::new();
    source.registry.authorize(&allowed.repo_path).unwrap();
    source.run_git(&["remote", "add", "origin", "https://example.invalid/safe"]);
    source.run_git(&[
        "config",
        &format!("url.{}.pushInsteadOf", outside.repo_str()),
        "https://example.invalid/",
    ]);
    source.run_git(&[
        "config",
        &format!("url.{}.pushInsteadOf", allowed.repo_str()),
        "https://example.invalid/safe",
    ]);
    let actual = std::process::Command::new("git")
        .args(["remote", "get-url", "--push", "origin"])
        .current_dir(&source.repo_path)
        .output()
        .unwrap();
    assert!(actual.status.success());
    assert_eq!(
        String::from_utf8(actual.stdout).unwrap().trim(),
        allowed.repo_str()
    );
    let error = operations::push(&source.registry, &source.repo_str(), &source.workspace)
        .err()
        .unwrap();
    assert!(
        matches!(
            error,
            oarlock_lib::modules::git::errors::GitError::NoUpstream
        ),
        "{error}"
    );
}

#[test]
fn explicit_push_url_ignores_push_instead_of() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let outside = GitRepoFixture::new();
    let allowed = GitRepoFixture::new();
    source.registry.authorize(&allowed.repo_path).unwrap();
    source.run_git(&["remote", "add", "origin", "https://example.invalid/safe"]);
    source.run_git(&["config", "remote.origin.pushurl", &allowed.repo_str()]);
    source.run_git(&[
        "config",
        &format!("url.{}.pushInsteadOf", outside.repo_str()),
        &allowed.repo_str(),
    ]);
    let error = operations::push(&source.registry, &source.repo_str(), &source.workspace)
        .err()
        .unwrap();
    assert!(
        matches!(
            error,
            oarlock_lib::modules::git::errors::GitError::NoUpstream
        ),
        "{error}"
    );
}

#[cfg(unix)]
#[test]
fn canonical_remote_paths_with_control_characters_are_refused() {
    use std::os::unix::fs::symlink;
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let temp = tempfile::tempdir().unwrap();
    let actual = temp.path().join("remote\nname");
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(&actual)
        .status()
        .unwrap()
        .success());
    let alias = temp.path().join("safe-name");
    symlink(&actual, &alias).unwrap();
    source.registry.authorize(&actual).unwrap();
    source.run_git(&["remote", "add", "origin", alias.to_str().unwrap()]);
    let error =
        operations::fetch(&source.registry, &source.repo_str(), &source.workspace).unwrap_err();
    assert!(error.to_string().contains("control character"), "{error}");
}
