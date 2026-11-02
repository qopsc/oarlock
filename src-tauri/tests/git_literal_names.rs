mod common;
use common::GitRepoFixture;
use oarlock_lib::modules::git::operations;

#[cfg(unix)]
#[test]
fn stage_diff_and_unstage_literal_unix_filenames() {
    let fixture = GitRepoFixture::new();
    let names = [":name\tline\n.txt", "\\literal.txt", ":(glob)*"];
    for path in names { fixture.write_file(path, "before\n"); }
    fixture.write_file("ordinary.txt", "before\n");
    fixture.run_git(&["add", "--all"]);
    fixture.run_git(&["commit", "-qm", "initial"]);
    for path in names { fixture.write_file(path, "after\n"); }
    fixture.write_file("ordinary.txt", "after\n");
    for path in names {
        operations::stage(&fixture.registry, &fixture.repo_str(), &[path.into()], &fixture.workspace).unwrap();
        let diff = operations::diff_content(&fixture.registry, &fixture.repo_str(), path, true, None, &fixture.workspace).unwrap();
        assert_eq!(diff.original_content, "before\n");
        assert_eq!(diff.modified_content, "after\n");
        let other = operations::diff_content(&fixture.registry, &fixture.repo_str(), "ordinary.txt", true, None, &fixture.workspace).unwrap();
        assert_eq!(other.original_content, other.modified_content, "staging a literal name touched another file");
        operations::unstage(&fixture.registry, &fixture.repo_str(), &[path.into()], &fixture.workspace).unwrap();
    }
    let other = operations::diff_content(&fixture.registry, &fixture.repo_str(), "ordinary.txt", true, None, &fixture.workspace).unwrap();
    assert_eq!(other.original_content, other.modified_content);
}

#[cfg(unix)]
#[test]
fn a_colon_named_symlink_cannot_escape_the_repository() {
    use std::os::unix::fs::symlink;
    let fixture = GitRepoFixture::new();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("file.txt"), "private").unwrap();
    symlink(outside.path(), fixture.repo_path.join(":link")).unwrap();
    let result = operations::stage(
        &fixture.registry, &fixture.repo_str(), &[":link/file.txt".into()], &fixture.workspace,
    );
    assert!(result.is_err());
    assert_eq!(std::fs::read(outside.path().join("file.txt")).unwrap(), b"private");
}
