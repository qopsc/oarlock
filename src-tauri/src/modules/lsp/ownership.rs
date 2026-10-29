//! Ownership is registered before blocking startup; cancellation removes the
//! reservation, so a late child can never be published into a retired page.
use std::collections::HashMap;

pub(super) struct Entry<T> {
    pub window: String,
    pub page: String,
    pub preset: String,
    pub generation: u64,
    pub value: Option<T>,
}
pub(super) struct Ownership<T> {
    pub entries: HashMap<u32, Entry<T>>,
    generations: HashMap<(String, String, String), u64>,
}
impl<T> Default for Ownership<T> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            generations: HashMap::new(),
        }
    }
}
impl<T> Ownership<T> {
    pub fn reserve(
        &mut self,
        id: u32,
        window: &str,
        page: &str,
        preset: &str,
        generation: u64,
    ) -> Result<(), String> {
        let minimum = self
            .generations
            .entry((window.into(), page.into(), preset.into()))
            .or_default();
        if generation < *minimum {
            return Err("lsp: configuration generation expired".into());
        }
        // A newer start does not replace older ownership; retirement explicitly
        // kills those entries. Never allow duplicate IDs to overwrite a child.
        if self.entries.contains_key(&id) {
            return Err("lsp: session ID exhausted".into());
        }
        self.entries.insert(
            id,
            Entry {
                window: window.into(),
                page: page.into(),
                preset: preset.into(),
                generation,
                value: None,
            },
        );
        Ok(())
    }
    pub fn publish(&mut self, id: u32, value: T) -> Result<(), String> {
        let entry = self.entries.get_mut(&id).ok_or("lsp: startup cancelled")?;
        entry.value = Some(value);
        Ok(())
    }
    pub fn retire(&mut self, window: &str, page: &str, preset: &str, generation: u64) -> Vec<T> {
        let minimum = self
            .generations
            .entry((window.into(), page.into(), preset.into()))
            .or_default();
        *minimum = (*minimum).max(generation);
        let minimum = *minimum;
        self.remove_where(|e| {
            e.window == window && e.page == page && e.preset == preset && e.generation < minimum
        })
    }
    pub fn release_window(&mut self, window: &str) -> Vec<T> {
        self.generations.retain(|(owner, _, _), _| owner != window);
        self.remove_where(|e| e.window == window)
    }
    fn remove_where(&mut self, predicate: impl Fn(&Entry<T>) -> bool) -> Vec<T> {
        let ids: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, e)| predicate(e))
            .map(|(id, _)| *id)
            .collect();
        ids.into_iter()
            .filter_map(|id| self.entries.remove(&id).and_then(|e| e.value))
            .collect()
    }
    pub fn owned(&self, id: u32, window: &str, page: &str) -> bool {
        self.entries
            .get(&id)
            .is_some_and(|e| e.window == window && e.page == page)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retirement_invalidates_pending_and_running_only_for_its_owner() {
        let mut registry = Ownership::<u32>::default();
        registry.reserve(1, "a", "old", "rust", 0).unwrap();
        registry.reserve(2, "a", "old", "rust", 0).unwrap();
        registry.entries.get_mut(&2).unwrap().value = Some(2);
        registry.reserve(3, "b", "page", "rust", 0).unwrap();
        assert_eq!(registry.retire("a", "old", "rust", 1), vec![2]);
        assert!(!registry.entries.contains_key(&1));
        assert!(registry.reserve(4, "a", "old", "rust", 0).is_err());
        registry.reserve(5, "a", "old", "rust", 1).unwrap();
        registry.retire("a", "old", "rust", 0);
        assert!(registry.owned(5, "a", "old"));
        registry.release_window("a");
        assert!(registry.owned(3, "b", "page"));
        assert!(!registry.owned(3, "a", "page"));
        assert!(!registry.owned(3, "b", "old"));
        assert!(!registry.entries.contains_key(&5));
    }
    #[test]
    fn page_retirement_rejects_late_admission_and_late_publication() {
        use crate::modules::net::page::NetworkPages;
        use std::sync::Mutex;
        let pages = NetworkPages::default();
        let registry = Mutex::new(Ownership::<u32>::default());
        pages.begin("main", || {}).unwrap();
        let old = pages.finish("main").unwrap();
        pages
            .with_page("main", &old, || {
                registry.lock().unwrap().reserve(1, "main", &old, "rust", 0)
            })
            .unwrap();
        pages
            .begin("main", || {
                registry.lock().unwrap().release_window("main");
            })
            .unwrap();
        let new = pages.finish("main").unwrap();
        assert!(pages
            .with_page("main", &old, || registry
                .lock()
                .unwrap()
                .reserve(2, "main", &old, "rust", 0))
            .is_err());
        assert!(registry.lock().unwrap().publish(1, 1).is_err());
        pages
            .with_page("main", &new, || {
                registry.lock().unwrap().reserve(3, "main", &new, "rust", 0)
            })
            .unwrap();
        assert!(!registry.lock().unwrap().owned(3, "main", &old));
        registry.lock().unwrap().publish(3, 3).unwrap();
        pages.close("main", || {
            assert_eq!(registry.lock().unwrap().release_window("main"), vec![3]);
        });
    }
}
