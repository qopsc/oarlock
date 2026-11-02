//! Resolve Cargo's edition without running repository-controlled Cargo commands.
use crate::modules::workspace::Gates;
use std::{fs::File, io::Read, path::Path};

const MAX_MANIFEST: u64 = 1024 * 1024;

fn manifest(path: &Path, gates: &Gates<'_>) -> Result<Option<toml::Value>, String> {
    let real = match std::fs::symlink_metadata(path) {
        Ok(_) => gates.authorized_existing(path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot inspect {}: {error}", path.display())),
    };
    let file =
        File::open(&real).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err(format!(
            "Cargo manifest is not a regular file: {}",
            path.display()
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err(format!("Cargo manifest exceeds 1 MiB: {}", path.display()));
    }
    let source = std::str::from_utf8(&bytes)
        .map_err(|error| format!("Invalid Cargo manifest {}: {error}", path.display()))?;
    source
        .parse()
        .map(Some)
        .map_err(|error| format!("Invalid Cargo manifest {}: {error}", path.display()))
}

fn edition(value: &toml::Value, path: &Path) -> Result<String, String> {
    match value.as_str() {
        Some(value @ ("2015" | "2018" | "2021" | "2024")) => Ok(value.to_owned()),
        _ => Err(format!("Unsupported Cargo edition in {}", path.display())),
    }
}

/// A loose file retains the previous 2021 default; a Cargo package follows its manifest.
pub(super) fn for_document(path: &Path, gates: &Gates<'_>) -> Result<String, String> {
    let Some(start) = path.parent() else {
        return Err("Document has no parent directory".into());
    };
    for dir in start.ancestors().take_while(|dir| gates.reaches(dir)) {
        let file = dir.join("Cargo.toml");
        let Some(data) = manifest(&file, gates)? else {
            continue;
        };
        let Some(package) = data.get("package") else {
            continue;
        };
        let Some(value) = package.get("edition") else {
            return Ok("2015".into());
        };
        if value.as_str().is_some() {
            return edition(value, &file);
        }
        if value.get("workspace").and_then(toml::Value::as_bool) != Some(true) {
            return Err(format!("Invalid Cargo edition in {}", file.display()));
        }
        if let Some(explicit) = package.get("workspace").and_then(toml::Value::as_str) {
            let root = gates.authorized_existing(&dir.join(explicit))?;
            let root_file = root.join("Cargo.toml");
            let root_data = manifest(&root_file, gates)?
                .ok_or_else(|| format!("Workspace manifest not found: {}", root_file.display()))?;
            return workspace_edition(&root_data, &root_file);
        }
        for ancestor in dir
            .ancestors()
            .take_while(|ancestor| gates.reaches(ancestor))
        {
            let root_file = ancestor.join("Cargo.toml");
            if let Some(root_data) = manifest(&root_file, gates)? {
                if root_data.get("workspace").is_some() {
                    return workspace_edition(&root_data, &root_file);
                }
            }
        }
        return Err(format!(
            "Cannot find an authorized Cargo workspace for {}",
            file.display()
        ));
    }
    Ok("2021".into())
}

fn workspace_edition(data: &toml::Value, path: &Path) -> Result<String, String> {
    let value = data
        .get("workspace")
        .and_then(|v| v.get("package"))
        .and_then(|v| v.get("edition"))
        .ok_or_else(|| format!("Workspace edition is missing in {}", path.display()))?;
    edition(value, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::workspace::{Origin, WorkspaceRegistry};
    use std::fs;

    #[test]
    fn resolves_package_defaults_and_workspace_inheritance() {
        let root = tempfile::tempdir().unwrap();
        let package = std::fs::canonicalize(root.path()).unwrap().join("member");
        fs::create_dir(&package).unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(root.path()).unwrap();
        let gates = registry.gates(Origin::App);
        let file = package.join("lib.rs");
        assert_eq!(for_document(&file, &gates).unwrap(), "2021");
        fs::write(package.join("Cargo.toml"), "[package]\nname='test'\n").unwrap();
        assert_eq!(for_document(&file, &gates).unwrap(), "2015");
        fs::write(
            package.join("Cargo.toml"),
            "[package]\nname='test'\nedition='2024'\n",
        )
        .unwrap();
        assert_eq!(for_document(&file, &gates).unwrap(), "2024");
        let mut args = super::super::arguments("rustfmt", file.to_str().unwrap(), "").unwrap();
        let content = "fn main() { let gen = 1; }";
        let run = |args: &[String]| {
            super::super::run(
                args,
                package.to_str().unwrap(),
                content,
                &crate::modules::workspace::WorkspaceEnv::Local,
                std::time::Duration::from_secs(10),
                &crate::modules::proc::capture::Cancellation::default(),
            )
        };
        assert!(run(&args).is_ok(), "2021 accepts gen as an identifier");
        args[4] = for_document(&file, &gates).unwrap();
        assert!(
            run(&args).is_err(),
            "2024 reserves gen and must not use 2021 parsing"
        );
        fs::write(
            root.path().join("Cargo.toml"),
            "[workspace]\n[workspace.package]\nedition='2018'\n",
        )
        .unwrap();
        fs::write(
            package.join("Cargo.toml"),
            "[package]\nname='test'\nedition.workspace=true\n",
        )
        .unwrap();
        assert_eq!(for_document(&file, &gates).unwrap(), "2018");
        fs::write(
            package.join("Cargo.toml"),
            "[package]\nname='test'\nworkspace='..'\nedition.workspace=true\n",
        )
        .unwrap();
        assert_eq!(for_document(&file, &gates).unwrap(), "2018");
        fs::write(package.join("Cargo.toml"), "[package\n").unwrap();
        assert!(for_document(&file, &gates).is_err());
    }

    #[test]
    fn refuses_workspace_inheritance_outside_authorized_folders() {
        let root = tempfile::tempdir().unwrap();
        let package = std::fs::canonicalize(root.path()).unwrap().join("member");
        fs::create_dir(&package).unwrap();
        fs::write(
            package.join("Cargo.toml"),
            "[package]\nname='test'\nedition.workspace=true\nworkspace='..'\n",
        )
        .unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(&package).unwrap();
        assert!(for_document(&package.join("lib.rs"), &registry.gates(Origin::App)).is_err());
    }
}
