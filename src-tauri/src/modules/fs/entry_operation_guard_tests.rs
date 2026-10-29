use super::require_owned_entry_operation;

#[cfg(unix)]
#[path = "entry_operation_primitive_tests.rs"]
mod primitive_tests;

#[cfg(target_os = "macos")]
#[path = "folder_clone_primitive_tests.rs"]
mod folder_clone_primitive_tests;

#[test]
fn unavailable_entry_operations_fail_before_their_work_can_run() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("file");
    std::fs::write(&file, "keep").unwrap();
    let attempt = || -> Result<(), String> {
        require_owned_entry_operation()?;
        std::fs::remove_file(&file).map_err(|error| error.to_string())
    };
    let error = attempt().unwrap_err();
    assert!(error.contains("cannot be safely verified"));
    assert_eq!(std::fs::read_to_string(file).unwrap(), "keep");
}
