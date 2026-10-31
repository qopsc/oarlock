pub mod agent;
pub mod ai_endpoints;
pub mod ai_sessions;
#[cfg(target_os = "macos")]
pub mod app_menu;
pub mod asset_all_folders;
pub mod asset_scope;
#[cfg(feature = "bench")]
pub mod bench;
pub mod clipboard_image;
pub mod clipboard_read;
pub mod clipboard_snapshot;
pub mod clipboard_write;
#[cfg(target_os = "linux")]
pub mod color_scheme;
pub mod control;
pub mod fs;
pub mod git;
pub mod history;
pub mod ipc_body;
pub mod lsp;
#[cfg(any(target_os = "macos", test))]
pub mod mac_privacy;
pub mod mcp;
#[cfg(any(target_os = "macos", test))]
pub mod menu_shortcuts;
pub mod net;
pub mod panics;
pub mod preferences;
pub mod primary_selection;
pub mod proc;
pub mod profile;
pub mod project_memory;
pub mod project_trust;
pub mod pty;
pub mod quick_terminal;
pub mod runtime;
pub mod second_launch;
pub mod secrets;
pub mod shell;
pub mod skills;
pub mod store_scope;
pub mod system_fonts;
pub mod terminal_scrollback;
pub mod themes;
pub mod vibrancy;
pub mod window_presentation;
pub mod windows;
pub mod workspace;

pub mod ai_metadata;

pub mod ai_subagents;

pub mod ai_chat_control;

pub(crate) mod base64;
pub(crate) mod secret_paths;
