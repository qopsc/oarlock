#![cfg(unix)]

mod common;

use common::{git_available, GitRepoFixture};
use oarlock_lib::modules::git::operations;
use std::fs;
use std::os::unix::fs::symlink;

#[derive(Clone, Copy, Debug)]
enum Alias {
    Hard,
    Leaf,
    Parent,
}

fn fixture(alias: Alias) -> (GitRepoFixture, tempfile::TempDir) {
    let repo = GitRepoFixture::new();
    for path in ["hard", "leaf", "parent/item"] {
        repo.write_file(path, "before\n");
    }
    repo.run_git(&["add", "."]);
    repo.run_git(&["commit", "-q", "-m", "before"]);
    repo.run_git(&["checkout", "-q", "-b", "next"]);
    for path in ["hard", "leaf", "parent/item"] {
        repo.write_file(path, "after\n");
    }
    repo.run_git(&["add", "."]);
    repo.run_git(&["commit", "-q", "-m", "after"]);
    repo.run_git(&["switch", "-q", "main"]);
    let store = tempfile::tempdir().unwrap();
    let protected = store.path().join("item");
    fs::write(&protected, "before\n").unwrap();
    match alias {
        Alias::Hard => {
            fs::remove_file(repo.repo_path.join("hard")).unwrap();
            fs::hard_link(&protected, repo.repo_path.join("hard")).unwrap();
        }
        Alias::Leaf => {
            fs::remove_file(repo.repo_path.join("leaf")).unwrap();
            symlink(&protected, repo.repo_path.join("leaf")).unwrap();
        }
        Alias::Parent => {
            fs::remove_dir_all(repo.repo_path.join("parent")).unwrap();
            symlink(store.path(), repo.repo_path.join("parent")).unwrap();
        }
    }
    (repo, store)
}

#[test]
fn pull_does_not_write_through_store_aliases() {
    if !git_available() { return; }
    for alias in [Alias::Hard, Alias::Leaf, Alias::Parent] {
        let (repo, store) = fixture(alias);
        repo.run_git(&["config", "branch.main.remote", "."]);
        repo.run_git(&["config", "branch.main.merge", "refs/heads/next"]);
        let result = operations::pull_ff_only(&repo.registry, &repo.repo_str(), &repo.workspace);
        assert_eq!(fs::read(store.path().join("item")).unwrap(), b"before\n", "{alias:?}: {result:?}");
        match alias {
            Alias::Hard => {
                result.expect("pull should replace an ordinary tracked hard link");
                assert_eq!(fs::read(repo.repo_path.join("hard")).unwrap(), b"after\n");
            }
            _ => assert!(result.is_err(), "Git should refuse local symlink changes: {alias:?}"),
        }
    }
}

#[test]
fn checkout_does_not_write_through_store_aliases() {
    if !git_available() { return; }
    for alias in [Alias::Hard, Alias::Leaf, Alias::Parent] {
        let (repo, store) = fixture(alias);
        let result = operations::checkout_branch(&repo.registry, &repo.repo_str(), "next", &repo.workspace);
        assert_eq!(fs::read(store.path().join("item")).unwrap(), b"before\n", "{alias:?}: {result:?}");
        match alias {
            Alias::Hard => {
                result.expect("checkout should replace an ordinary tracked hard link");
                assert_eq!(fs::read(repo.repo_path.join("hard")).unwrap(), b"after\n");
            }
            _ => assert!(result.is_err(), "Git should refuse local symlink changes: {alias:?}"),
        }
    }
}
