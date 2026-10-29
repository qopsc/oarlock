//! Native commit refuses repository-configured executables. Changes by another
//! local process after inspection remain a documented best-effort race.
#![cfg(unix)]

mod common;

use common::{git_available, GitRepoFixture};
use oarlock_lib::modules::git::operations;
use std::os::unix::fs::PermissionsExt;

fn fixture() -> GitRepoFixture {
    let fx = GitRepoFixture::new();
    fx.write_file("file.txt", "content\n");
    fx.run_git(&["add", "file.txt"]);
    fx
}

fn executable(path: &std::path::Path, body: &str) {
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn commit_refuses_executable_hook_without_running_it() {
    if !git_available() {
        return;
    }
    let fx = fixture();
    fx.run_git(&["config", "core.hooksPath", ".git/hooks"]);
    executable(
        &fx.repo_path.join(".git/hooks/pre-commit"),
        "#!/bin/sh\nprintf ran > .git/oarlock-hook-marker\n",
    );

    let result = operations::commit(&fx.registry, &fx.repo_str(), "test commit", &fx.workspace);
    assert!(
        !fx.repo_path.join(".git/oarlock-hook-marker").exists(),
        "native commit ran the configured hook"
    );
    assert!(result.is_err(), "commit must refuse executable hooks");
}

#[test]
fn commit_refuses_executable_fsmonitor_without_running_it() {
    if !git_available() {
        return;
    }
    let fx = fixture();
    let monitor = fx.repo_path.join("monitor.sh");
    executable(
        &monitor,
        "#!/bin/sh\nprintf ran > .git/oarlock-monitor-marker\n",
    );
    fx.run_git(&["config", "core.fsmonitor", monitor.to_str().unwrap()]);

    let result = operations::commit(&fx.registry, &fx.repo_str(), "test commit", &fx.workspace);
    assert!(
        !fx.repo_path.join(".git/oarlock-monitor-marker").exists(),
        "native commit ran the configured filesystem monitor"
    );
    assert!(result.is_err(), "commit must refuse executable fsmonitor");
}

#[test]
fn commit_refuses_configured_executable_classes() {
    if !git_available() {
        return;
    }
    for (key, value, label) in [
        ("hook.probe.command", "sh ./probe.sh", "hook"),
        ("hook.probe.event", "pre-commit", "hook"),
        ("core.hooksPath", ".git/hooks", "core.hooksPath"),
        ("core.fsmonitor", "./probe.sh", "core.fsmonitor"),
        ("filter.probe.clean", "sh ./probe.sh", "filter"),
        ("filter.probe.smudge", "sh ./probe.sh", "filter"),
        ("filter.probe.process", "sh ./probe.sh", "filter"),
        ("diff.probe.command", "sh ./probe.sh", "diff"),
        ("diff.probe.textconv", "sh ./probe.sh", "diff"),
        ("diff.external", "sh ./probe.sh", "diff"),
        ("merge.probe.driver", "sh ./probe.sh", "merge"),
        ("credential.helper", "!sh ./probe.sh", "credential"),
        ("core.sshCommand", "sh ./probe.sh", "core.sshCommand"),
        ("core.askPass", "sh ./probe.sh", "core.askPass"),
        ("core.editor", "sh ./probe.sh", "core.editor"),
        ("core.pager", "sh ./probe.sh", "core.pager"),
        ("sequence.editor", "sh ./probe.sh", "sequence.editor"),
        ("trailer.probe.cmd", "sh ./probe.sh", "trailer"),
        ("trailer.probe.command", "sh ./probe.sh", "trailer"),
        (
            "interactive.diffFilter",
            "sh ./probe.sh",
            "interactive.diffFilter",
        ),
        (
            "core.alternateRefsCommand",
            "sh ./probe.sh",
            "alternateRefsCommand",
        ),
        ("gc.recentObjectsHook", "sh ./probe.sh", "object-processing"),
        (
            "uploadpack.packObjectsHook",
            "sh ./probe.sh",
            "object-processing",
        ),
        ("remote.probe.vcs", "probe", "remote helper"),
        ("remote.probe.promisor", "true", "partial clone"),
        (
            "remote.probe.partialclonefilter",
            "blob:none",
            "partial clone",
        ),
        ("commit.gpgSign", "true", "commit.gpgSign"),
        ("gpg.program", "sh ./probe.sh", "signing"),
        ("gpg.ssh.defaultKeyCommand", "sh ./probe.sh", "signing"),
    ] {
        let fx = fixture();
        fx.run_git(&["config", "--local", key, value]);
        let result = operations::commit(&fx.registry, &fx.repo_str(), "test commit", &fx.workspace);
        let error = result.err().unwrap_or_else(|| panic!("{key} was accepted"));
        assert!(error.to_string().contains(label), "{key}: {error}");
    }
}

#[test]
fn commit_refuses_executable_in_included_repo_config() {
    if !git_available() {
        return;
    }
    let fx = fixture();
    fx.write_file(
        "included.conf",
        "[filter \"probe\"]\n clean = sh ./probe.sh\n",
    );
    fx.run_git(&["config", "--local", "include.path", "../included.conf"]);
    let result = operations::commit(&fx.registry, &fx.repo_str(), "test commit", &fx.workspace);
    assert!(result.err().unwrap().to_string().contains("filter"));
}

#[test]
fn clean_commit_accepts_nonexecutable_sample_hooks() {
    if !git_available() {
        return;
    }
    let fx = fixture();
    let hook = fx.repo_path.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o600)).unwrap();
    if let Err(error) =
        operations::commit(&fx.registry, &fx.repo_str(), "test commit", &fx.workspace)
    {
        panic!("commit failed: {error}");
    }
}

#[test]
fn repository_config_loaded_by_global_include_is_refused() {
    use oarlock_lib::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};
    use std::process::Command;
    const CHILD: &str = "OARLOCK_R054A_INCLUDE_CHILD";
    if let Ok(repo) = std::env::var(CHILD) {
        let registry = WorkspaceRegistry::default();
        registry.authorize(std::path::Path::new(&repo)).unwrap();
        let result = operations::commit(&registry, &repo, "test commit", &WorkspaceEnv::Local);
        let error = result.err().expect("repository include must be refused");
        assert!(error.to_string().contains("credential.helper"), "{error}");
        return;
    }
    if !git_available() {
        return;
    }
    let fx = fixture();
    fx.write_file("included.conf", "[credential]\n helper = !sh ./probe.sh\n");
    let home = tempfile::tempdir().unwrap();
    let gitdir = fx.repo_path.clone();
    std::fs::write(
        home.path().join(".gitconfig"),
        format!(
            "[includeIf \"gitdir:{}/\"]\n path = {}\n",
            gitdir.display(),
            fx.repo_path.join("included.conf").display()
        ),
    )
    .unwrap();
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "repository_config_loaded_by_global_include_is_refused",
            "--nocapture",
        ])
        .env("HOME", home.path())
        .env(CHILD, fx.repo_str())
        .output()
        .unwrap();
    assert!(
        child.status.success(),
        "child failed: {} {}",
        String::from_utf8_lossy(&child.stdout),
        String::from_utf8_lossy(&child.stderr)
    );
}

#[test]
fn commit_refuses_a_symlink_hooks_directory() {
    if !git_available() {
        return;
    }
    let fx = fixture();
    std::fs::remove_dir_all(fx.repo_path.join(".git/hooks")).unwrap();
    std::os::unix::fs::symlink(fx.repo_path.join(".git"), fx.repo_path.join(".git/hooks")).unwrap();
    let result = operations::commit(&fx.registry, &fx.repo_str(), "test commit", &fx.workspace);
    assert!(result
        .err()
        .unwrap()
        .to_string()
        .contains("symbolic-link Git hooks directory"));
}

#[test]
fn commit_refuses_a_hook_in_the_default_hooks_directory() {
    if !git_available() {
        return;
    }
    let fx = fixture();
    executable(
        &fx.repo_path.join(".git/hooks/pre-commit"),
        "#!/bin/sh\nprintf ran > .git/default-hook-marker\n",
    );
    let result = operations::commit(&fx.registry, &fx.repo_str(), "test commit", &fx.workspace);
    let error = result
        .err()
        .expect("default executable hook must be refused");
    assert!(error.to_string().contains("pre-commit"), "{error}");
    assert!(!fx.repo_path.join(".git/default-hook-marker").exists());
}
