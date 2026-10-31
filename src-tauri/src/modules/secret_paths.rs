//! Shared secret-path policy for native content imports.
use std::path::Path;

pub(crate) fn readable(path: &Path) -> bool {
    use std::sync::OnceLock;
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Rules {
        basenames: Vec<String>,
        directories: Vec<String>,
        component_prefixes: Vec<String>,
    }
    static RULES: OnceLock<(regex::RegexSet, Vec<String>, Vec<String>)> = OnceLock::new();
    let (basenames, directories, prefixes) = RULES.get_or_init(|| {
        let rules: Rules =
            serde_json::from_str(include_str!("../../../src/modules/ai/lib/secretPaths.json"))
                .expect("valid shared secret path rules");
        let patterns = regex::RegexSetBuilder::new(&rules.basenames)
            .case_insensitive(true)
            .build()
            .expect("valid shared secret basename patterns");
        (patterns, rules.directories, rules.component_prefixes)
    });
    let path = path.to_string_lossy().replace('\\', "/");
    if path.chars().any(char::is_control)
        || basenames.is_match(path.rsplit('/').next().unwrap_or(""))
    {
        return false;
    }
    let comparison = path
        .split('/')
        .map(|part| {
            part.split(':')
                .next()
                .unwrap_or("")
                .trim_end_matches(|c: char| c == '.' || c.is_whitespace())
                .to_lowercase()
        })
        .collect::<Vec<_>>()
        .join("/")
        + "/";
    if comparison
        .split('/')
        .any(|part| prefixes.iter().any(|prefix| part.starts_with(prefix)))
    {
        return false;
    }
    !directories
        .iter()
        .any(|dir| comparison.contains(&format!("{dir}/")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn internal_staging_is_never_an_ai_content_source() {
        for path in [
            "/work/.oarlock-stage-0123/content",
            "/work/.oarlock-save-0123",
            r"C:\work\.OARLOCK-STAGE-0123.\content",
            "/work/.oarlock-stage-0123",
        ] {
            assert!(!readable(Path::new(path)), "{path}");
        }
        assert!(readable(Path::new("/work/notes.oarlock-stage-0123")));
    }
}
