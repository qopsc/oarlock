mod common;

use std::collections::BTreeMap;

use common::{git_available, GitRepoFixture};
use oarlock_lib::modules::git::{
    candidate_index::{plan, EntryValue, IndexError},
    candidate_object::{ObjectIdentity, ObjectKind},
};

#[test]
fn captured_blob_identity_drives_index_validation_against_real_git() {
    if !git_available() {
        return;
    }
    let fx = GitRepoFixture::new();
    let content = b"authorized content\n";
    fx.write_file("file.txt", std::str::from_utf8(content).unwrap());
    fx.run_git(&["add", "file.txt"]);
    let candidate = std::fs::read(fx.repo_path.join(".git/index")).unwrap();
    let identity = ObjectIdentity::capture(ObjectKind::Blob, content, 1024).unwrap();
    let expected = BTreeMap::from([(
        b"file.txt".to_vec(),
        Some(EntryValue {
            mode: 0o100644,
            oid: identity.git_oid(),
        }),
    )]);
    assert!(plan(None, &candidate, &expected).is_ok());

    let changed = ObjectIdentity::capture(ObjectKind::Blob, b"changed\n", 1024).unwrap();
    let wrong = BTreeMap::from([(
        b"file.txt".to_vec(),
        Some(EntryValue {
            mode: 0o100644,
            oid: changed.git_oid(),
        }),
    )]);
    assert!(matches!(
        plan(None, &candidate, &wrong),
        Err(IndexError::UnexpectedValue)
    ));
}
