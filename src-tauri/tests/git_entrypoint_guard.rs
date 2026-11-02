#![cfg(unix)]

mod common;

use common::{git_available, GitRepoFixture};
use oarlock_lib::modules::git::operations;
use std::os::unix::fs::PermissionsExt;

#[test]
fn stage_refuses_a_repository_clean_filter_without_executing_it() {
    if !git_available() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.write_file(".gitattributes", "file.txt filter=probe\n");
    fx.write_file("file.txt", "content\n");
    let filter = fx.repo_path.join("filter.sh");
    std::fs::write(
        &filter,
        "#!/bin/sh\nprintf ran > .git/oarlock-filter-marker\ncat\n",
    )
    .unwrap();
    std::fs::set_permissions(&filter, std::fs::Permissions::from_mode(0o700)).unwrap();
    fx.run_git(&["config", "filter.probe.clean", "sh ./filter.sh"]);

    let result = operations::stage(
        &fx.registry,
        &fx.repo_str(),
        &["file.txt".to_owned()],
        &fx.workspace,
    );
    assert!(
        !fx.repo_path.join(".git/oarlock-filter-marker").exists(),
        "native Stage ran the repository's clean filter"
    );
    assert!(result.is_err(), "native Stage must refuse the filter");
}

fn hostile_fixture() -> GitRepoFixture {
    let fx = GitRepoFixture::new();
    fx.write_file("file.txt", "content\n");
    fx.run_git(&["config", "filter.probe.clean", "sh ./filter.sh"]);
    fx
}

macro_rules! refusal_case {
    ($name:ident, |$fx:ident| $call:expr) => {
        #[test]
        fn $name() {
            if !git_available() {
                return;
            }
            let $fx = hostile_fixture();
            let result = $call;
            let error = result
                .err()
                .unwrap_or_else(|| panic!("{} accepted an executable filter", stringify!($name)));
            assert!(
                error.to_string().contains("filter"),
                "{}: {}",
                stringify!($name),
                error
            );
        }
    };
}

refusal_case!(resolve_repo_refuses_filter, |fx| operations::resolve_repo(
    &fx.registry,
    &fx.repo_str(),
    &fx.workspace
));
refusal_case!(panel_snapshot_refuses_filter, |fx| {
    operations::panel_snapshot(&fx.registry, &fx.repo_str(), &fx.workspace)
});
refusal_case!(status_refuses_filter, |fx| operations::status(
    &fx.registry,
    &fx.repo_str(),
    &fx.workspace
));
refusal_case!(diff_refuses_filter, |fx| operations::diff(
    &fx.registry,
    &fx.repo_str(),
    Some("file.txt"),
    false,
    &fx.workspace
));
refusal_case!(diff_content_refuses_filter, |fx| operations::diff_content(
    &fx.registry,
    &fx.repo_str(),
    "file.txt",
    false,
    None,
    &fx.workspace
));
refusal_case!(file_base_refuses_filter, |fx| operations::file_base(
    &fx.registry,
    fx.repo_path.join("file.txt").to_str().unwrap(),
    &fx.workspace
));
refusal_case!(unstage_refuses_filter, |fx| operations::unstage(
    &fx.registry,
    &fx.repo_str(),
    &["file.txt".into()],
    &fx.workspace
));
refusal_case!(discard_refuses_filter, |fx| operations::discard(
    &fx.registry,
    &fx.repo_str(),
    &[oarlock_lib::modules::git::types::DiscardEntry {
        path: "file.txt".into(),
        untracked: true
    }],
    &fx.workspace
));
refusal_case!(commit_refuses_filter, |fx| operations::commit(
    &fx.registry,
    &fx.repo_str(),
    "message",
    &fx.workspace
));
refusal_case!(undo_refuses_filter, |fx| operations::undo_last_commit(
    &fx.registry,
    &fx.repo_str(),
    "0000000000000000000000000000000000000000",
    "main",
    &fx.workspace
));
refusal_case!(commit_on_remote_refuses_filter, |fx| {
    operations::commit_on_remote(
        &fx.registry,
        &fx.repo_str(),
        "0000000000000000000000000000000000000000",
        &fx.workspace,
    )
});
refusal_case!(push_refuses_filter, |fx| operations::push(
    &fx.registry,
    &fx.repo_str(),
    &fx.workspace
));
refusal_case!(log_refuses_filter, |fx| operations::log(
    &fx.registry,
    &fx.repo_str(),
    10,
    0,
    None,
    &fx.workspace
));
refusal_case!(show_commit_refuses_filter, |fx| {
    operations::show_commit_diff(
        &fx.registry,
        &fx.repo_str(),
        "0000000000000000000000000000000000000000",
        &fx.workspace,
    )
});
refusal_case!(commit_files_refuses_filter, |fx| operations::commit_files(
    &fx.registry,
    &fx.repo_str(),
    "0000000000000000000000000000000000000000",
    &fx.workspace
));
refusal_case!(commit_file_diff_refuses_filter, |fx| {
    operations::commit_file_diff(
        &fx.registry,
        &fx.repo_str(),
        "0000000000000000000000000000000000000000",
        "file.txt",
        None,
        &fx.workspace,
    )
});
refusal_case!(remote_url_refuses_filter, |fx| operations::remote_url(
    &fx.registry,
    &fx.repo_str(),
    "origin",
    &fx.workspace
));
refusal_case!(fetch_refuses_filter, |fx| operations::fetch(
    &fx.registry,
    &fx.repo_str(),
    &fx.workspace
));
refusal_case!(pull_refuses_filter, |fx| operations::pull_ff_only(
    &fx.registry,
    &fx.repo_str(),
    &fx.workspace
));
refusal_case!(branches_refuse_filter, |fx| operations::list_branches(
    &fx.registry,
    &fx.repo_str(),
    &fx.workspace
));
refusal_case!(checkout_refuses_filter, |fx| operations::checkout_branch(
    &fx.registry,
    &fx.repo_str(),
    "main",
    &fx.workspace
));

#[test]
fn missing_optional_worktree_config_does_not_block_status() {
    if !git_available() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.run_git(&["config", "extensions.worktreeConfig", "true"]);
    assert!(operations::status(&fx.registry, &fx.repo_str(), &fx.workspace).is_ok());
}

#[test]
fn executable_worktree_config_is_refused() {
    if !git_available() {
        return;
    }
    let fx = GitRepoFixture::new();
    fx.run_git(&["config", "extensions.worktreeConfig", "true"]);
    fx.run_git(&[
        "config",
        "--worktree",
        "filter.probe.clean",
        "sh ./filter.sh",
    ]);
    let error = operations::status(&fx.registry, &fx.repo_str(), &fx.workspace)
        .err()
        .unwrap();
    assert!(error.to_string().contains("filter"), "{error}");
}

#[test]
fn fetch_refuses_external_transport_before_running_it() {
    if !git_available() {
        return;
    }
    let fx = GitRepoFixture::new();
    executable_file(&fx.repo_path.join("remote-helper.sh"));
    fx.run_git(&["config", "protocol.ext.allow", "always"]);
    fx.run_git(&["config", "remote.origin.url", "ext::./remote-helper.sh"]);
    fx.run_git(&[
        "config",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/*",
    ]);
    let error = operations::fetch(&fx.registry, &fx.repo_str(), &fx.workspace)
        .err()
        .unwrap();
    assert!(error.to_string().contains("transport"), "{error}");
    assert!(!fx.repo_path.join(".git/oarlock-remote-marker").exists());
}

fn executable_file(path: &std::path::Path) {
    std::fs::write(path, "#!/bin/sh\nprintf ran > .git/oarlock-remote-marker\n").unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn remote_proxy_and_commands_are_refused() {
    if !git_available() {
        return;
    }
    for (key, value) in [
        ("core.gitProxy", "./proxy.sh"),
        ("remote.origin.uploadpack", "sh ./remote.sh"),
        ("remote.origin.receivepack", "sh ./remote.sh"),
        ("remote.origin.url", "ext::./remote.sh"),
        ("protocol.ext.allow", "always"),
    ] {
        let fx = GitRepoFixture::new();
        fx.run_git(&["config", key, value]);
        assert!(
            operations::fetch(&fx.registry, &fx.repo_str(), &fx.workspace).is_err(),
            "{key} was accepted"
        );
    }
}

#[test]
fn local_fetch_requires_separate_destination_authorization() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let remote = GitRepoFixture::new();
    source.run_git(&["remote", "add", "origin", &remote.repo_str()]);
    let error = operations::fetch(&source.registry, &source.repo_str(), &source.workspace)
        .err()
        .unwrap();
    assert!(
        error
            .to_string()
            .contains("outside the authorized workspace"),
        "{error}"
    );
    source.registry.authorize(&remote.repo_path).unwrap();
    if let Err(error) = operations::fetch(&source.registry, &source.repo_str(), &source.workspace) {
        panic!("authorized local fetch failed: {error}");
    }
}

#[test]
fn authorized_local_remote_hooks_are_refused_before_push() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let remote = GitRepoFixture::new();
    source.run_git(&["remote", "add", "origin", &remote.repo_str()]);
    source.registry.authorize(&remote.repo_path).unwrap();
    let hook = remote.repo_path.join(".git/hooks/pre-receive");
    executable_file(&hook);
    let error = operations::push(&source.registry, &source.repo_str(), &source.workspace)
        .err()
        .unwrap();
    assert!(error.to_string().contains("pre-receive"), "{error}");
    assert!(!remote.repo_path.join(".git/oarlock-remote-marker").exists());
}

#[test]
fn local_file_url_requires_separate_destination_authorization() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let remote = GitRepoFixture::new();
    let url = tauri::Url::from_directory_path(&remote.repo_path)
        .unwrap()
        .to_string();
    source.run_git(&["remote", "add", "origin", &url]);
    assert!(
        operations::fetch(&source.registry, &source.repo_str(), &source.workspace)
            .err()
            .unwrap()
            .to_string()
            .contains("outside the authorized workspace")
    );
}

#[test]
fn rewritten_remote_url_is_checked_after_git_expands_it() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let remote = GitRepoFixture::new();
    let url = tauri::Url::from_directory_path(&remote.repo_path)
        .unwrap()
        .to_string();
    let key = format!("url.{url}.insteadOf");
    source.run_git(&["config", &key, "https://example.invalid/repo"]);
    source.run_git(&["remote", "add", "origin", "https://example.invalid/repo"]);
    let error = operations::fetch(&source.registry, &source.repo_str(), &source.workspace)
        .err()
        .unwrap();
    assert!(
        error
            .to_string()
            .contains("outside the authorized workspace"),
        "{error}"
    );
}

refusal_case!(ai_staged_git_diff_refuses_filter, |fx| {
    oarlock_lib::modules::git::ai_diff::staged_diff(&fx.registry, &fx.repo_str(), &fx.workspace)
});

#[test]
fn authorized_clean_bare_remote_can_push_and_fetch() {
    if !git_available() {
        return;
    }
    let source = GitRepoFixture::new();
    let holder = tempfile::tempdir().unwrap();
    let remote = holder.path().join("remote.git");
    let result = std::process::Command::new("git")
        .args(["init", "--bare", "-q"])
        .arg(&remote)
        .status()
        .unwrap();
    assert!(result.success());
    source.registry.authorize(&remote).unwrap();
    source.write_file("file.txt", "first\n");
    source.run_git(&["add", "file.txt"]);
    source.run_git(&["commit", "-qm", "initial"]);
    source.run_git(&["remote", "add", "origin", remote.to_str().unwrap()]);
    source.run_git(&["push", "-u", "origin", "main"]);
    source.write_file("file.txt", "second\n");
    source.run_git(&["add", "file.txt"]);
    source.run_git(&["commit", "-qm", "second"]);
    match operations::push(&source.registry, &source.repo_str(), &source.workspace) {
        Ok(result) => assert!(result.pushed),
        Err(error) => panic!("authorized push failed: {error}"),
    }
    if let Err(error) = operations::fetch(&source.registry, &source.repo_str(), &source.workspace) {
        panic!("authorized fetch failed: {error}");
    }
}
