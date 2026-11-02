//! Bounded ownership of automatic discovery, separate from interactive sign-in.
use futures_util::future::{AbortHandle, AbortRegistration};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

type Key = (String, String);
struct Entry {
    server: String,
    abort: AbortHandle,
}
#[derive(Clone, Default)]
pub(super) struct Probes(Arc<Mutex<HashMap<Key, Entry>>>);
pub(super) struct Lease {
    probes: Probes,
    key: Key,
}

impl Probes {
    pub fn admit(
        &self,
        window: &str,
        id: &str,
        server: &str,
    ) -> Result<(Lease, AbortRegistration), String> {
        if id.is_empty()
            || id.len() > 64
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err("Invalid metadata discovery request id".into());
        }
        let mut entries = super::lock(&self.0);
        let key = (window.into(), id.into());
        if entries.contains_key(&key) {
            return Err("Metadata discovery is already active".into());
        }
        if entries.len() >= 8 {
            return Err("Metadata discovery is busy (8 active); retry shortly".into());
        }
        let (abort, registration) = AbortHandle::new_pair();
        entries.insert(
            key.clone(),
            Entry {
                server: server.into(),
                abort,
            },
        );
        Ok((
            Lease {
                probes: self.clone(),
                key,
            },
            registration,
        ))
    }
    pub fn cancel_window(&self, window: &str) {
        for ((owner, _), entry) in super::lock(&self.0).iter() {
            if owner == window {
                entry.abort.abort();
            }
        }
    }
    pub fn cancel_server(&self, server: &str) {
        for entry in super::lock(&self.0).values() {
            if entry.server == server {
                entry.abort.abort();
            }
        }
    }
    pub fn cancel(&self, window: &str, id: &str) {
        if let Some(entry) = super::lock(&self.0).get(&(window.into(), id.into())) {
            entry.abort.abort();
        }
    }
}
impl Lease {
    /// Serialize publication with cancellation, including page retirement.
    pub fn publish<T>(&self, publish: impl FnOnce() -> T) -> Result<T, String> {
        let entries = super::lock(&self.probes.0);
        if entries
            .get(&self.key)
            .is_none_or(|entry| entry.abort.is_aborted())
        {
            return Err("Metadata discovery cancelled".into());
        }
        Ok(publish())
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        super::lock(&self.probes.0).remove(&self.key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{future::Abortable, FutureExt};
    #[test]
    fn page_retirement_rejects_queued_discovery_and_suppresses_publication() {
        let pages = crate::modules::net::page::NetworkPages::default();
        let probes = Probes::default();
        pages.begin("settings", || {}).unwrap();
        let page = pages.finish("settings").unwrap();
        let (lease, registration) = pages
            .with_page("settings", &page, || {
                probes.admit("settings", "active", "server")
            })
            .unwrap();
        pages.close("settings", || probes.cancel_window("settings"));
        assert!(pages
            .with_page("settings", &page, || probes
                .admit("settings", "queued", "server"))
            .is_err());
        assert!(lease
            .publish(|| panic!("retired page published discovery"))
            .is_err());
        assert!(Abortable::new(std::future::pending::<()>(), registration)
            .now_or_never()
            .unwrap()
            .is_err());
    }
    #[test]
    fn bounds_all_windows_and_cancellation_prevents_io_and_publication() {
        let probes = Probes::default();
        let tickets: Vec<_> = (0..8)
            .map(|i| probes.admit("settings", &i.to_string(), "server").unwrap())
            .collect();
        assert!(probes.admit("other", "extra", "server").is_err());
        probes.cancel_server("server");
        for (lease, registration) in tickets {
            assert!(lease.publish(|| panic!("cancelled publication")).is_err());
            assert!(
                Abortable::new(async { panic!("cancelled I/O") }, registration)
                    .now_or_never()
                    .unwrap()
                    .is_err()
            );
        }
        let (lease, registration) = probes.admit("other", "extra", "different").unwrap();
        probes.cancel_window("settings");
        assert_eq!(lease.publish(|| 7), Ok(7));
        probes.cancel("other", "extra");
        assert!(Abortable::new(std::future::pending::<()>(), registration)
            .now_or_never()
            .unwrap()
            .is_err());
    }
}
