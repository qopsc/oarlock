//! Foreground session ownership. Retiring sessions stay reachable by shutdown
//! until their process cleanup finishes; a new page cannot reuse an old lifetime.
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone)]
pub(super) struct Owner {
    label: String,
    lifetime: Arc<()>,
}
struct Entry<T> {
    owner: Owner,
    value: T,
    retiring: bool,
}
pub(super) struct SessionRegistry<T> {
    owners: HashMap<String, Arc<()>>,
    entries: HashMap<u32, Entry<T>>,
    next_id: u32,
    closed: bool,
}
impl<T> Default for SessionRegistry<T> {
    fn default() -> Self {
        Self {
            owners: HashMap::new(),
            entries: HashMap::new(),
            next_id: 0,
            closed: false,
        }
    }
}
impl<T: Clone> SessionRegistry<T> {
    pub fn owner(&mut self, label: &str) -> Result<Owner, String> {
        if self.closed {
            return Err("The app is shutting down.".into());
        }
        let lifetime = self
            .owners
            .entry(label.into())
            .or_insert_with(|| Arc::new(()))
            .clone();
        Ok(Owner {
            label: label.into(),
            lifetime,
        })
    }
    pub fn insert(&mut self, owner: Owner, value: T) -> Result<u32, String> {
        if self.closed
            || !self
                .owners
                .get(&owner.label)
                .is_some_and(|current| Arc::ptr_eq(current, &owner.lifetime))
        {
            return Err("The shell's window closed or reloaded.".into());
        }
        let id = self
            .next_id
            .checked_add(1)
            .ok_or("Shell handles exhausted; restart the app.")?;
        self.next_id = id;
        self.entries.insert(
            id,
            Entry {
                owner,
                value,
                retiring: false,
            },
        );
        Ok(id)
    }
    #[cfg(test)]
    pub fn get(&self, id: &u32) -> Option<&T> {
        self.entries
            .get(id)
            .filter(|entry| !entry.retiring)
            .map(|entry| &entry.value)
    }
    pub fn get_owned(&self, label: &str, id: u32) -> Option<&T> {
        let entry = self.entries.get(&id)?;
        (!entry.retiring && self.owns(label, entry)).then_some(&entry.value)
    }
    fn owns(&self, label: &str, entry: &Entry<T>) -> bool {
        entry.owner.label == label
            && self
                .owners
                .get(label)
                .is_some_and(|live| Arc::ptr_eq(live, &entry.owner.lifetime))
    }
    pub fn retire_owned(&mut self, label: &str, id: u32) -> Option<T> {
        if !self.owns(label, self.entries.get(&id)?) {
            return None;
        }
        let entry = self.entries.get_mut(&id)?;
        entry.retiring = true;
        Some(entry.value.clone())
    }
    pub fn retire_matching(&mut self, matches: impl Fn(&T) -> bool) -> Vec<(u32, T)> {
        self.entries
            .iter_mut()
            .filter_map(|(&id, entry)| {
                if !matches(&entry.value) {
                    return None;
                }
                entry.retiring = true;
                Some((id, entry.value.clone()))
            })
            .collect()
    }
    pub fn release_window(&mut self, label: &str) -> Vec<(u32, T)> {
        self.owners.remove(label);
        self.entries
            .iter_mut()
            .filter_map(|(&id, entry)| {
                if entry.owner.label != label {
                    return None;
                }
                entry.retiring = true;
                Some((id, entry.value.clone()))
            })
            .collect()
    }
    pub fn finish(&mut self, id: u32) {
        self.entries.remove(&id);
    }
    pub fn close(&mut self) -> Vec<(u32, T)> {
        self.closed = true;
        self.owners.clear();
        self.retire_matching(|_| true)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handles_cannot_be_used_or_closed_by_another_window_or_reloaded_page() {
        let mut sessions = SessionRegistry::default();
        let owner = sessions.owner("a").unwrap();
        let id = sessions.insert(owner, "shell").unwrap();
        assert!(sessions.get_owned("b", id).is_none());
        assert!(sessions.retire_owned("b", id).is_none());
        assert_eq!(sessions.get_owned("a", id), Some(&"shell"));
        sessions.release_window("a");
        sessions.owner("a").unwrap();
        assert!(sessions.get_owned("a", id).is_none());
        assert!(sessions.retire_owned("a", id).is_none());
        assert_eq!(sessions.close(), vec![(id, "shell")]);
    }
    #[test]
    fn reload_invalidates_pending_opens_without_rejecting_the_new_page() {
        let mut sessions = SessionRegistry::default();
        let old = sessions.owner("main").unwrap();
        assert!(sessions.release_window("main").is_empty());
        let new = sessions.owner("main").unwrap();
        assert!(sessions.insert(old, "stale").is_err());
        let id = sessions.insert(new, "new").unwrap();
        assert_eq!(sessions.get(&id), Some(&"new"));
    }
    #[test]
    fn release_is_window_scoped_and_shutdown_keeps_retiring_sessions() {
        let mut sessions = SessionRegistry::default();
        let a = sessions.owner("a").unwrap();
        let b = sessions.owner("b").unwrap();
        let first = sessions.insert(a, "same chat").unwrap();
        let second = sessions.insert(b, "same chat").unwrap();
        assert_eq!(sessions.release_window("a"), vec![(first, "same chat")]);
        assert!(sessions.get(&first).is_none());
        assert!(sessions.get(&second).is_some());
        let all = sessions.close();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|(id, _)| *id == first));
        assert!(sessions.owner("a").is_err());
        sessions.finish(first);
        assert_eq!(sessions.close(), vec![(second, "same chat")]);
    }
    #[test]
    fn completion_from_an_old_page_cannot_remove_a_new_session() {
        let mut sessions = SessionRegistry::default();
        let old = sessions.owner("main").unwrap();
        let first = sessions.insert(old, ()).unwrap();
        sessions.release_window("main");
        let new = sessions.owner("main").unwrap();
        let second = sessions.insert(new, ()).unwrap();
        sessions.finish(first);
        assert!(sessions.get(&second).is_some());
        sessions.next_id = u32::MAX;
        let owner = sessions.owner("main").unwrap();
        assert!(sessions.insert(owner, ()).is_err());
        assert!(sessions.get(&second).is_some());
    }
}
