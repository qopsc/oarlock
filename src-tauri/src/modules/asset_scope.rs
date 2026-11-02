//! What the webview may load through asset URLs. The configured scope is empty
//! (`tauri.conf.json`), so a script in a webview cannot read an arbitrary file that way; the
//! backend grants, at runtime:
//!
//! Tauri's own `asset:` protocol cannot be switched off (the `protocol-asset` feature must
//! match the config), and it types a file by its extension (HTML for an unknown one), adds
//! neither a sandbox nor a page token, and the dialog plugin grants every folder the user
//! picks to it. So its scope is made to match nothing: every filesystem root is forbidden
//! (`forbidden_roots`), and a forbidden pattern beats any allowed one. Everything loads
//! through `oarlock-asset` (`asset_all_folders.rs`), which judges requests with `Access`:
//!
//! - every authorized workspace root, recursively, as the registry authorizes it: the editor's
//!   image, video, audio and PDF previews and the Markdown preview's images. A WSL root is
//!   registered by its host path (the share or the drive), which is also what `fs_host_path`
//!   turns a WSL file into for its asset URL. A root is kept under its authorized spelling and
//!   its resolved one, so a request is judged by its name alone, with no disk access.
//! - each installed font face `system_font_faces` hands the terminal, as a single file.
//!
//! The configured scope's `requireLiteralLeadingDot` still decides dot names below a root, so
//! on every platform a granted home folder does not expose `~/.ssh`.
//!
//! "Allow the app to access all folders" adds no root: `oarlock-asset` asks the setting on
//! every request.

use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use tauri::utils::config::FsScope;
use tauri::Manager;

use super::workspace::WorkspaceRegistry;

/// The app's previews and fonts, served by `oarlock-asset`.
pub struct AssetScope {
    access: Access,
}

/// What `oarlock-asset` may serve besides everything while "access all folders" is on: the
/// authorized workspace roots, recursively, and never the app's own state.
pub struct Access {
    /// The app's own data, config and local data folders, resolved. Nothing there is ever a
    /// preview: it holds the stores, the trust decisions and the secrets file.
    app_state: Vec<PathBuf>,
    literal_leading_dot: bool,
    granted_roots: Mutex<Vec<PathBuf>>,
    font_files: Mutex<Vec<PathBuf>>,
}

/// Whether the configured scope's wildcards skip names that start with a dot, as Tauri
/// decides it.
fn literal_leading_dot(config: &FsScope) -> bool {
    match config {
        FsScope::Scope {
            require_literal_leading_dot: Some(required),
            ..
        } => *required,
        _ => cfg!(unix),
    }
}

/// Whether a recursive grant of `granted` already lets the scope serve everything under
/// `root`: `root` lies inside it, and no folder on the way down is one its wildcard skips.
fn covers(granted: &Path, root: &Path, literal_leading_dot: bool) -> bool {
    let Ok(rest) = root.strip_prefix(granted) else {
        return false;
    };
    !literal_leading_dot
        || rest.components().all(|component| match component {
            Component::Normal(name) => !name.to_string_lossy().starts_with('.'),
            _ => true,
        })
}

/// Whether a newly authorized `root` needs a grant of its own. A root the earlier grants
/// already cover adds nothing; skipping it keeps the scope's pattern list, which every asset
/// request scans, from growing with each folder a terminal visits.
fn needs_grant(root: &Path, granted: &[PathBuf], literal_leading_dot: bool) -> bool {
    !granted
        .iter()
        .any(|granted| covers(granted, root, literal_leading_dot))
}

/// Whether `path` lies in one of `dirs`. Windows paths compare without regard to case, as the
/// filesystem does.
fn under_any(path: &Path, dirs: &[PathBuf]) -> bool {
    dirs.iter().any(|dir| within(dir, path))
}

fn within(dir: &Path, path: &Path) -> bool {
    if cfg!(windows) {
        let fold = |p: &Path| {
            p.components()
                .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
                .collect::<Vec<_>>()
        };
        let (dir, path) = (fold(dir), fold(path));
        path.starts_with(&dir)
    } else {
        path.starts_with(dir)
    }
}

/// Whether a granted root lets a request for `path` through the scope's wildcard rule: it lies
/// in the root and no folder below the root starts with a dot.
fn rooted(path: &Path, roots: &[PathBuf], literal_leading_dot: bool) -> bool {
    roots.iter().any(|root| {
        if cfg!(windows) {
            within(root, path) && covers_ignoring_case(root, path, literal_leading_dot)
        } else {
            covers(root, path, literal_leading_dot)
        }
    })
}

fn covers_ignoring_case(root: &Path, path: &Path, literal_leading_dot: bool) -> bool {
    let depth = root.components().count();
    !literal_leading_dot
        || path
            .components()
            .skip(depth)
            .all(|component| match component {
                Component::Normal(name) => !name.to_string_lossy().starts_with('.'),
                _ => true,
            })
}

impl Access {
    pub(crate) fn new(app_state: Vec<PathBuf>, literal_leading_dot: bool) -> Self {
        Self {
            app_state,
            literal_leading_dot,
            granted_roots: Mutex::new(Vec::new()),
            font_files: Mutex::new(Vec::new()),
        }
    }

    /// Whether `real`, a resolved path, is in the app's own state folders.
    pub fn is_app_state(&self, real: &Path) -> bool {
        under_any(real, &self.app_state)
    }

    /// Whether the resolved `real` lies in an authorized root without crossing a dot name.
    pub fn in_workspace(&self, real: &Path) -> bool {
        let roots = self
            .granted_roots
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        rooted(real, &roots, self.literal_leading_dot)
    }

    /// Whether the resolved `real` is a font face the backend handed out.
    pub fn is_font(&self, real: &Path) -> bool {
        let fonts = self
            .font_files
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        fonts
            .iter()
            .any(|font| within(font, real) && within(real, font))
    }

    /// Whether the opened file's resolved path may be served at all: a workspace file or a font.
    pub fn permits(&self, real: &Path) -> bool {
        self.in_workspace(real) || self.is_font(real)
    }

    /// Whether a request for the name `path`, as the page wrote it, may be opened. Judged by the
    /// name alone, with no disk access: roots are kept under their authorized and resolved
    /// spellings, so a name through a link (`~/code` to a volume, macOS `/tmp`) matches one of
    /// them, and a name that matches none never reaches the filesystem. The opened file is
    /// judged again by `serves_opened`. With every folder allowed only dot names and `..` are
    /// turned away here.
    pub fn may_open(&self, path: &Path, all_folders: bool) -> bool {
        if path.components().any(|part| part == Component::ParentDir) {
            return false;
        }
        self.permits(path) || (all_folders && !has_dot_name(path))
    }

    pub(crate) fn grant_root(&self, root: &Path) {
        self.grant_root_as(root, std::fs::canonicalize(root).ok());
    }

    fn grant_root_as(&self, root: &Path, resolved: Option<PathBuf>) {
        let mut granted = self
            .granted_roots
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        for spelling in std::iter::once(root.to_path_buf()).chain(resolved) {
            if needs_grant(&spelling, &granted, self.literal_leading_dot) {
                granted.push(spelling);
            }
        }
    }

    /// Lets `oarlock-asset` serve one file, such as a font face the backend chose.
    pub(crate) fn grant_font(&self, file: &Path) {
        let mut fonts = self
            .font_files
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        for spelling in std::iter::once(file.to_path_buf()).chain(std::fs::canonicalize(file).ok())
        {
            if !fonts.contains(&spelling) {
                fonts.push(spelling);
            }
        }
    }
}

fn has_dot_name(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name.to_string_lossy().starts_with('.'),
        _ => false,
    })
}

impl AssetScope {
    pub fn access(&self) -> &Access {
        &self.access
    }

    /// Lets the webview load one file through `oarlock-asset`, such as a font face.
    pub fn grant_file(&self, file: &Path) {
        self.access.grant_font(file);
    }
}

/// The roots whose whole tree Tauri's asset scope must refuse: `/`, or every drive letter and
/// the UNC and verbatim prefixes on Windows.
fn forbidden_roots() -> Vec<PathBuf> {
    if cfg!(windows) {
        let mut roots: Vec<PathBuf> = ('A'..='Z')
            .flat_map(|drive| {
                [
                    PathBuf::from(format!("{drive}:\\")),
                    PathBuf::from(format!("\\\\?\\{drive}:\\")),
                ]
            })
            .collect();
        roots.push(PathBuf::from("\\\\"));
        roots
    } else {
        vec![PathBuf::from("/")]
    }
}

/// What to do with an event of Tauri's asset scope: whatever the dialog plugin (or anyone)
/// allows is forbidden at once. The root forbids alone are not enough, because the scope sets
/// `requireLiteralLeadingDot`, so `/**` never matches below a dot-named folder such as
/// `~/.config/proj`; a pattern made from the allowed path itself names that folder literally.
fn on_scope_event(event: &tauri::scope::fs::Event, forbid: impl Fn(&Path)) {
    if let tauri::scope::fs::Event::PathAllowed(path) = event {
        forbid(path);
    }
}

/// Records every workspace root the registry has authorized and will authorize.
pub fn install(app: &tauri::AppHandle) {
    let scope = app.asset_protocol_scope();
    let forbidding = scope.clone();
    scope.listen(move |event| {
        on_scope_event(event, |path| {
            if let Err(e) = forbidding.forbid_directory(path, true) {
                log::warn!("asset scope: cannot forbid {}: {e}", path.display());
            }
            if let Err(e) = forbidding.forbid_file(path) {
                log::warn!("asset scope: cannot forbid {}: {e}", path.display());
            }
        });
    });
    for root in forbidden_roots() {
        if let Err(e) = scope.forbid_directory(&root, true) {
            log::warn!("asset scope: cannot forbid {}: {e}", root.display());
        }
    }
    let paths = app.path();
    let app_state: Vec<PathBuf> = [
        paths.app_data_dir(),
        paths.app_config_dir(),
        paths.app_local_data_dir(),
    ]
    .into_iter()
    .flatten()
    .map(|dir| std::fs::canonicalize(&dir).unwrap_or(dir))
    .collect();
    app.manage(AssetScope {
        access: Access::new(
            app_state,
            literal_leading_dot(&app.config().app.security.asset_protocol.scope),
        ),
    });
    let handle = app.clone();
    app.state::<WorkspaceRegistry>()
        .watch_roots(move |root| handle.state::<AssetScope>().access.grant_root(root));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn the_apps_state_folders_are_recognized_by_their_resolved_path() {
        let state = paths(&["/home/me/.local/share/app", "/home/me/.config/app"]);
        assert!(under_any(
            Path::new("/home/me/.config/app/oarlock-spaces.json"),
            &state
        ));
        assert!(under_any(
            Path::new("/home/me/.local/share/app/x/y.png"),
            &state
        ));
        assert!(!under_any(
            Path::new("/home/me/.config/application/x.png"),
            &state
        ));
        assert!(!under_any(Path::new("/home/me/pictures/x.png"), &state));
        assert!(!under_any(Path::new("/home/me/pictures/x.png"), &[]));
    }

    #[test]
    fn a_workspace_file_is_served_below_a_root_and_not_through_a_dot_folder() {
        let access = Access::new(paths(&["/home/me/.config/app"]), true);
        access.grant_root(Path::new("/work/proj"));
        assert!(access.in_workspace(Path::new("/work/proj/docs/a.png")));
        assert!(!access.in_workspace(Path::new("/work/proj/.git/a.png")));
        assert!(!access.in_workspace(Path::new("/work/other/a.png")));
        assert!(!access.in_workspace(Path::new("/work/project/a.png")));
        assert!(access.is_app_state(Path::new("/home/me/.config/app/x.json")));
    }

    #[test]
    fn a_name_through_a_link_matches_a_root_kept_under_both_spellings() {
        let access = Access::new(vec![], true);
        access.grant_root_as(
            Path::new("/home/me/code/proj"),
            Some(PathBuf::from("/vol/code/proj")),
        );
        let open = |p: &str, all| access.may_open(Path::new(p), all);
        assert!(
            open("/home/me/code/proj/docs/a.png", false),
            "authorized spelling"
        );
        assert!(open("/vol/code/proj/a.png", false), "resolved spelling");
        assert!(!open("/home/me/code/other/a.png", false));
        assert!(
            !open("/net/host/share/a.png", false),
            "judged by name, never resolved"
        );
        assert!(!open("/home/me/code/proj/../x.png", true), "`..` never");
        assert!(
            open("/srv/photos/a.png", true),
            "any folder while all are allowed"
        );
        assert!(!open("/home/me/.ssh/id.png", true), "but not a dot name");
        assert!(!open("/nonexistent/dir/a.png", false));
    }

    #[cfg(unix)]
    #[test]
    fn granting_a_link_spelled_root_records_where_it_resolves() {
        let tmp = tempfile::Builder::new()
            .prefix("oarlock-grant-")
            .tempdir()
            .unwrap();
        let real = std::fs::canonicalize(tmp.path()).unwrap();
        std::fs::create_dir(real.join("vol")).unwrap();
        std::os::unix::fs::symlink(real.join("vol"), real.join("code")).unwrap();
        let access = Access::new(vec![], true);
        access.grant_root(&real.join("code"));
        assert!(access.may_open(&real.join("code").join("a.png"), false));
        assert!(access.in_workspace(&real.join("vol").join("a.png")));
    }

    #[test]
    fn font_faces_are_served_by_their_exact_file_only() {
        let access = Access::new(vec![], true);
        access.grant_font(Path::new("/Library/Fonts/Mono.ttf"));
        assert!(access.may_open(Path::new("/Library/Fonts/Mono.ttf"), false));
        assert!(access.permits(Path::new("/Library/Fonts/Mono.ttf")));
        assert!(!access.permits(Path::new("/Library/Fonts/Other.ttf")));
        assert!(!access.permits(Path::new("/Library/Fonts/Mono.ttf.html")));
        assert!(!access.permits(Path::new("/Library/Fonts")));
    }

    #[test]
    fn tauris_asset_scope_matches_nothing_whatever_the_dialog_grants() {
        // The dialog plugin allows every folder the user picks; a forbidden pattern wins.
        let options = glob::MatchOptions {
            require_literal_separator: true,
            require_literal_leading_dot: true,
            ..Default::default()
        };
        let sep = std::path::MAIN_SEPARATOR;
        let base = if cfg!(windows) {
            "C:\\Users\\me"
        } else {
            "/Users/me"
        };
        let join = |parts: &[&str]| {
            let mut path = PathBuf::from(base);
            path.extend(parts);
            path
        };
        let pattern = |dir: &Path| {
            glob::Pattern::new(&format!(
                "{}{sep}**",
                glob::Pattern::escape(&dir.to_string_lossy())
            ))
            .unwrap()
        };
        let roots = forbidden_roots();
        let root_forbids: Vec<_> = roots
            .iter()
            .map(|root| {
                glob::Pattern::new(&format!(
                    "{}**",
                    glob::Pattern::escape(&root.to_string_lossy())
                ))
                .unwrap()
            })
            .collect();
        let forbidden_by_roots = |file: &Path| {
            root_forbids
                .iter()
                .any(|p| p.matches_path_with(file, options))
        };

        // An ordinary folder is covered by the root forbids alone.
        assert!(forbidden_by_roots(&join(&["site", "index.html"])));

        // A folder at or below a dot-named part is not: `**` never enters it. That is why the
        // scope listener forbids each allowed path itself.
        for dir in [
            join(&[".config", "proj"]),
            join(&[".dotfiles"]),
            join(&[".local", "src", "app"]),
        ] {
            let file = dir.join("index.html");
            assert!(!forbidden_by_roots(&file), "roots alone miss {dir:?}");
            let forbidden = std::cell::RefCell::new(Vec::new());
            on_scope_event(&tauri::scope::fs::Event::PathAllowed(dir.clone()), |path| {
                forbidden.borrow_mut().push(path.to_path_buf())
            });
            let forbidden = forbidden.into_inner();
            assert_eq!(forbidden, vec![dir.clone()]);
            assert!(
                pattern(&forbidden[0]).matches_path_with(&file, options),
                "{dir:?}"
            );
            assert!(
                pattern(&forbidden[0]).matches_path_with(&dir.join("sub").join("a.html"), options)
            );
        }

        // Events that are not grants forbid nothing.
        let calls = std::cell::Cell::new(0);
        on_scope_event(
            &tauri::scope::fs::Event::PathForbidden(join(&["x"])),
            |_| calls.set(calls.get() + 1),
        );
        assert_eq!(calls.get(), 0);

        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert!(config["app"]["security"]["assetProtocol"]["scope"]["allow"]
            .as_array()
            .is_some_and(|allow| allow.is_empty()));
    }

    #[test]
    fn the_first_root_is_granted() {
        assert!(needs_grant(Path::new("/home/me"), &[], true));
    }

    #[test]
    fn a_root_inside_a_granted_one_adds_nothing() {
        let granted = paths(&["/home/me"]);
        for dot_rule in [true, false] {
            assert!(!needs_grant(Path::new("/home/me"), &granted, dot_rule));
            assert!(!needs_grant(
                Path::new("/home/me/src/app"),
                &granted,
                dot_rule
            ));
        }
    }

    #[test]
    fn a_dot_folder_needs_its_own_grant_where_wildcards_skip_it() {
        let granted = paths(&["/home/me"]);
        assert!(needs_grant(
            Path::new("/home/me/.config/nvim"),
            &granted,
            true
        ));
        assert!(needs_grant(
            Path::new("/home/me/src/.hidden/x"),
            &granted,
            true
        ));
        assert!(!needs_grant(
            Path::new("/home/me/.config/nvim"),
            &granted,
            false
        ));
        let inside_dot_root = paths(&["/home/me/.config"]);
        assert!(!needs_grant(
            Path::new("/home/me/.config/nvim"),
            &inside_dot_root,
            true
        ));
    }

    #[test]
    fn a_sibling_or_a_parent_is_granted() {
        let granted = paths(&["/home/me/app"]);
        assert!(needs_grant(Path::new("/home/me/app2"), &granted, true));
        assert!(needs_grant(Path::new("/home/me"), &granted, true));
        assert!(needs_grant(Path::new("/srv/data"), &granted, true));
    }

    #[cfg(windows)]
    #[test]
    fn wsl_and_drive_roots_are_matched_as_paths() {
        let granted = paths(&[r"\\?\UNC\wsl.localhost\Ubuntu\home\me", r"\\?\C:\Users\me"]);
        assert!(!needs_grant(
            Path::new(r"\\?\UNC\wsl.localhost\Ubuntu\home\me\src"),
            &granted,
            false
        ));
        assert!(needs_grant(
            Path::new(r"\\?\UNC\wsl.localhost\Debian\home\me"),
            &granted,
            false
        ));
        assert!(!needs_grant(
            Path::new(r"\\?\C:\Users\me\.ssh"),
            &granted,
            false
        ));
        assert!(needs_grant(
            Path::new(r"\\?\C:\Users\me\.ssh"),
            &granted,
            true
        ));
        assert!(needs_grant(Path::new(r"\\?\D:\photos"), &granted, false));
    }

    #[test]
    fn the_dot_rule_follows_the_config_and_tauris_default() {
        assert_eq!(literal_leading_dot(&FsScope::default()), cfg!(unix));
        let explicit = |required| FsScope::Scope {
            allow: Vec::new(),
            deny: Vec::new(),
            require_literal_leading_dot: Some(required),
        };
        assert!(literal_leading_dot(&explicit(true)));
        assert!(!literal_leading_dot(&explicit(false)));
    }

    #[test]
    fn nothing_is_allowed_by_configuration() {
        let configs = [
            include_str!("../../tauri.conf.json"),
            include_str!("../../tauri.linux.conf.json"),
            include_str!("../../tauri.windows.conf.json"),
        ];
        for (i, config) in configs.into_iter().enumerate() {
            let config: serde_json::Value = serde_json::from_str(config).unwrap();
            let scope = &config["app"]["security"]["assetProtocol"]["scope"];
            if scope.is_null() && i > 0 {
                continue;
            }
            let scope: FsScope = serde_json::from_value(scope.clone()).unwrap();
            assert!(scope.allowed_paths().is_empty(), "{scope:?}");
        }
    }

    #[test]
    fn wildcards_skip_dot_names_on_every_platform() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let scope: FsScope =
            serde_json::from_value(config["app"]["security"]["assetProtocol"]["scope"].clone())
                .unwrap();
        assert!(literal_leading_dot(&scope));
    }
}
