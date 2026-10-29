//! Admission and retention policy. Callers serialize transitions; no process or clock access.
use std::collections::HashMap;

const RUNNING_LIMIT: usize = 16;
const FINISHED_LIMIT: usize = 32;
struct Entry<T> {
    chat_id: Option<String>,
    value: Option<T>,
    finished: Option<u64>,
}
pub(super) struct JobRegistry<T> {
    entries: HashMap<u32, Entry<T>>,
    next_id: u32,
    completion: u64,
    closed: bool,
}
impl<T> Default for JobRegistry<T> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            next_id: 0,
            completion: 0,
            closed: false,
        }
    }
}
impl<T> JobRegistry<T> {
    #[cfg(test)]
    pub fn reserve(&mut self) -> Result<u32, String> {
        self.reserve_for(None)
    }
    pub fn reserve_for(&mut self, chat_id: Option<String>) -> Result<u32, String> {
        if self.closed {
            return Err("The app is shutting down; background jobs cannot start.".into());
        }
        // An unpublished process still occupies its reservation, even if it has
        // finished already. Slow spawn replies cannot bypass the admission limit.
        if self
            .entries
            .values()
            .filter(|e| e.value.is_none() || e.finished.is_none())
            .count()
            >= RUNNING_LIMIT
        {
            return Err("At most 16 background jobs can run at once. Stop an existing job or wait for it to finish before starting another.".into());
        }
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or("Background job handles exhausted; restart the app.")?;
        self.entries.insert(
            self.next_id,
            Entry {
                chat_id,
                value: None,
                finished: None,
            },
        );
        Ok(self.next_id)
    }
    pub fn abandon(&mut self, id: u32) {
        self.entries.remove(&id);
    }
    pub fn publish(&mut self, id: u32, value: T) -> Result<Vec<T>, T> {
        let Some(entry) = self.entries.get_mut(&id) else {
            return Err(value);
        };
        entry.value = Some(value);
        Ok(self.prune())
    }
    pub fn finish(&mut self, id: u32) -> Vec<T> {
        let Some(entry) = self.entries.get_mut(&id) else {
            return vec![];
        };
        if entry.finished.is_some() {
            return vec![];
        }
        self.completion += 1;
        entry.finished = Some(self.completion);
        self.prune()
    }
    fn prune(&mut self) -> Vec<T> {
        let mut finished: Vec<_> = self
            .entries
            .iter()
            .filter_map(|(&id, e)| {
                e.value.as_ref()?;
                Some((e.finished?, id))
            })
            .collect();
        finished.sort_unstable();
        let excess = finished.len().saturating_sub(FINISHED_LIMIT);
        finished
            .into_iter()
            .take(excess)
            .filter_map(|(_, id)| self.entries.remove(&id)?.value)
            .collect()
    }
    pub fn pending_for(&self, chat_id: &str) -> bool {
        self.entries
            .values()
            .any(|e| e.value.is_none() && e.chat_id.as_deref() == Some(chat_id))
    }
    pub fn get(&self, id: u32) -> Option<&T> {
        self.entries.get(&id)?.value.as_ref()
    }
    pub fn iter(&self) -> impl Iterator<Item = (u32, &T)> {
        self.entries
            .iter()
            .filter_map(|(&id, e)| Some((id, e.value.as_ref()?)))
    }
    pub fn close(&mut self) -> Vec<T> {
        self.closed = true;
        self.entries.drain().filter_map(|(_, e)| e.value).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unpublished_completion_remains_pending_until_publication_or_failure() {
        let mut jobs = JobRegistry::<()>::default();
        let a = jobs.reserve_for(Some("a".into())).unwrap();
        let b = jobs.reserve_for(Some("b".into())).unwrap();
        jobs.finish(a);
        assert!(jobs.pending_for("a"));
        jobs.publish(a, ()).unwrap();
        assert!(!jobs.pending_for("a"));
        assert!(jobs.pending_for("b"));
        jobs.abandon(b);
        assert!(!jobs.pending_for("b"));
    }
    #[test]
    fn reservations_count_toward_limit_and_failed_starts_release_slots() {
        let mut jobs = JobRegistry::<()>::default();
        let ids: Vec<_> = (0..16).map(|_| jobs.reserve().unwrap()).collect();
        assert!(jobs.reserve().unwrap_err().contains("16 background jobs"));
        jobs.abandon(ids[0]);
        assert!(jobs.reserve().is_ok());
        assert!(jobs.reserve().is_err());
    }
    #[test]
    fn completion_releases_admission_without_evicting_running_jobs() {
        let mut jobs = JobRegistry::default();
        let active = jobs.reserve().unwrap();
        jobs.publish(active, "active").unwrap();
        let mut completed = vec![];
        for _ in 0..40 {
            let id = jobs.reserve().unwrap();
            jobs.publish(id, "done").unwrap();
            jobs.finish(id);
            completed.push(id);
        }
        assert_eq!(jobs.iter().count(), 33);
        assert_eq!(jobs.get(active), Some(&"active"));
        for id in &completed[..8] {
            assert!(jobs.get(*id).is_none());
        }
        for id in &completed[8..] {
            assert_eq!(jobs.get(*id), Some(&"done"));
        }
    }
    #[test]
    fn retention_orders_by_completion_not_start_and_duplicate_completion_is_inert() {
        let mut jobs = JobRegistry::default();
        let long = jobs.reserve().unwrap();
        jobs.publish(long, ()).unwrap();
        let mut first = 0;
        for _ in 0..32 {
            let id = jobs.reserve().unwrap();
            if first == 0 {
                first = id;
            }
            jobs.publish(id, ()).unwrap();
            jobs.finish(id);
        }
        jobs.finish(first); // A repeated notification must not refresh history.
        jobs.finish(long);
        assert!(jobs.get(first).is_none());
        assert!(jobs.get(long).is_some());
    }
    #[test]
    fn completion_before_publication_keeps_its_order_and_reservation() {
        let mut jobs = JobRegistry::default();
        let early = jobs.reserve().unwrap();
        jobs.finish(early);
        for _ in 0..32 {
            let id = jobs.reserve().unwrap();
            jobs.publish(id, ()).unwrap();
            jobs.finish(id);
        }
        assert_eq!(jobs.publish(early, ()).unwrap().len(), 1);
        assert!(jobs.get(early).is_none());
        assert_eq!(jobs.iter().count(), 32);
        let pending: Vec<_> = (0..16).map(|_| jobs.reserve().unwrap()).collect();
        jobs.finish(pending[0]);
        assert!(jobs.reserve().is_err());
    }
    #[test]
    fn closing_rejects_pending_publications_and_future_starts() {
        let mut jobs = JobRegistry::default();
        let id = jobs.reserve().unwrap();
        assert!(jobs.close().is_empty());
        assert_eq!(jobs.publish(id, 7), Err(7));
        assert!(jobs.reserve().is_err());
        assert!(jobs.finish(id).is_empty());
    }
    #[test]
    fn simultaneous_reservations_share_one_global_limit() {
        use std::sync::{Arc, Barrier, Mutex};
        let registry = Arc::new(Mutex::new(JobRegistry::<()>::default()));
        let start = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let registry = registry.clone();
                let start = start.clone();
                std::thread::spawn(move || {
                    start.wait();
                    (0..4)
                        .filter(|_| registry.lock().unwrap().reserve().is_ok())
                        .count()
                })
            })
            .collect();
        assert_eq!(
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .sum::<usize>(),
            16
        );
        assert!(registry.lock().unwrap().reserve().is_err());
    }

    #[test]
    fn evicting_completed_history_releases_its_payload() {
        use std::sync::Arc;
        let mut registry = JobRegistry::default();
        let payload = Arc::new(vec![0u8; 4096]);
        let weak = Arc::downgrade(&payload);
        let oldest = registry.reserve().unwrap();
        registry.publish(oldest, payload).unwrap();
        registry.finish(oldest);
        for _ in 0..32 {
            let id = registry.reserve().unwrap();
            registry.publish(id, Arc::new(vec![])).unwrap();
            registry.finish(id);
        }
        assert!(weak.upgrade().is_none());
    }
}
