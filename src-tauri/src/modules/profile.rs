//! Persistence identities. Production keeps its existing locations and accounts.
use std::borrow::Cow;

pub const PRODUCTION: &str = "consulting.quantumops.oarlock";
pub const DEVELOPMENT: &str = "consulting.quantumops.oarlock.dev";

pub fn identifier(configured: &str, development: bool) -> &str {
    if development && configured == PRODUCTION {
        DEVELOPMENT
    } else {
        configured
    }
}

pub fn secret_service<'a>(identifier: &str, service: &'a str) -> Cow<'a, str> {
    if identifier == PRODUCTION {
        Cow::Borrowed(service)
    } else {
        Cow::Owned(format!("{service}@{identifier}"))
    }
}

pub fn control_directory(identifier: &str) -> &str {
    if identifier == PRODUCTION {
        "oarlock"
    } else {
        identifier
    }
}

pub fn autostart_name<'a>(identifier: &str, name: &'a str) -> Cow<'a, str> {
    match identifier {
        PRODUCTION => Cow::Borrowed(name),
        DEVELOPMENT => Cow::Owned(format!("{name} (Development)")),
        other => Cow::Owned(format!("{name} ({other})")),
    }
}

pub fn shell_cache_directory(development: bool) -> &'static str {
    if development {
        "oarlock-dev"
    } else {
        "oarlock"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn development_and_production_never_share_persistence_identities() {
        let release = identifier(PRODUCTION, false);
        let dev = identifier(PRODUCTION, true);
        assert_eq!(release, PRODUCTION);
        assert_eq!(dev, DEVELOPMENT);
        assert_ne!(control_directory(release), control_directory(dev));
        assert_eq!(autostart_name(release, "Oarlock"), "Oarlock");
        assert_ne!(
            autostart_name(release, "Oarlock"),
            autostart_name(dev, "Oarlock")
        );
        for service in ["oarlock-ai", "oarlock-mcp"] {
            assert_eq!(secret_service(release, service), service);
            assert_ne!(
                secret_service(release, service),
                secret_service(dev, service)
            );
        }
        assert_ne!(shell_cache_directory(false), shell_cache_directory(true));
    }
    #[test]
    fn explicit_test_profiles_are_preserved_and_have_separate_secrets() {
        let lab = "consulting.quantumops.oarlock.app-lab";
        assert_eq!(identifier(lab, true), lab);
        assert_eq!(identifier(lab, false), lab);
        assert_ne!(
            secret_service(lab, "oarlock-mcp"),
            secret_service(DEVELOPMENT, "oarlock-mcp")
        );
    }
}
