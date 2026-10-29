//! Explicit, on-demand capability discovery. A connected helper is NOT a
//! publication permit. No Git process or fallback is launched by this command.
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    worker_connected: bool,
    execution_ready: bool,
    git_verified: bool,
    guidance: Option<&'static str>,
    reason: String,
}

fn probe(identifier: &str) -> Capability {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::{c_char, CStr, CString};
        unsafe extern "C" {
            fn oarlock_git_worker_probe(
                app_id: *const c_char,
                detail: *mut c_char,
                capacity: usize,
                development: bool,
            ) -> i32;
        }
        let Ok(identifier) = CString::new(identifier) else {
            return Capability {
                worker_connected: false,
                execution_ready: false,
                git_verified: false,
                guidance: None,
                reason: "invalid_profile".into(),
            };
        };
        let mut detail = [0 as c_char; 128];
        // The bridge accepts only this bounded output buffer and keeps all
        // asynchronous callbacks in heap-owned state after a timeout.
        let status = unsafe {
            oarlock_git_worker_probe(
                identifier.as_ptr(),
                detail.as_mut_ptr(),
                detail.len(),
                cfg!(debug_assertions),
            )
        };
        let reason = unsafe { CStr::from_ptr(detail.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        from_probe(status, reason)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = identifier;
        Capability {
            worker_connected: false,
            execution_ready: false,
            git_verified: false,
            guidance: None,
            reason: "platform_worker_unavailable".into(),
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn from_probe(status: i32, reason: String) -> Capability {
    Capability {
        worker_connected: matches!(status, 0 | 2),
        execution_ready: false,
        git_verified: status == 0,
        guidance: (status == 2).then_some(
            "Isolated Source Control needs a verified, protected Apple Git installation. Install or repair Apple's Command Line Tools using xcode-select --install, then retry. Terminal Git is unchanged.",
        ),
        reason,
    }
}

#[tauri::command]
pub async fn git_execution_capability(app: tauri::AppHandle) -> Result<Capability, String> {
    let identifier = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || probe(&identifier))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn an_unbundled_process_never_advertises_execution_or_falls_back() {
        let result = probe("consulting.quantumops.oarlock.dev");
        assert!(!result.execution_ready);
        assert!(!result.worker_connected);
        assert!(!result.reason.is_empty());
    }
    #[test]
    fn missing_apple_git_is_distinct_from_a_broken_helper_and_never_enables_execution() {
        let missing = from_probe(2, "apple_git_required".into());
        assert!(missing.worker_connected);
        assert!(!missing.git_verified);
        assert!(!missing.execution_ready);
        assert!(missing.guidance.unwrap().contains("xcode-select --install"));
        let verified = from_probe(0, "candidate_execution_unavailable".into());
        assert!(verified.git_verified);
        assert!(!verified.execution_ready);
        assert!(verified.guidance.is_none());
        let failed = from_probe(1, "helper_protocol_mismatch".into());
        assert!(!failed.worker_connected);
        assert!(!failed.git_verified);
        assert!(failed.guidance.is_none());
    }
}
