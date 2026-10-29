//! Per-page run leases. Navigation preserves them; reload revokes pending opens.
use crate::modules::project_trust::OpenProject;
use std::collections::HashMap;
use std::sync::Arc;
#[derive(Default)]
pub(super) struct Leases {
    owners: HashMap<String, Arc<()>>,
    entries: HashMap<u64, (String, OpenProject)>,
    next: u64,
    closed: bool,
}
impl Leases {
    pub fn owner(&mut self, label: &str) -> Arc<()> {
        self.owners
            .entry(label.into())
            .or_insert_with(|| Arc::new(()))
            .clone()
    }
    pub fn is_live(&self, label: &str, owner: &Arc<()>) -> bool {
        !self.closed
            && self
                .owners
                .get(label)
                .is_some_and(|live| Arc::ptr_eq(live, owner))
    }
    pub fn all_projects(&self) -> Vec<OpenProject> {
        let mut projects = HashMap::new();
        for (_, project) in self.entries.values() {
            projects
                .entry(project.key.clone())
                .or_insert_with(|| project.clone());
        }
        projects.into_values().collect()
    }
    pub fn insert(
        &mut self,
        label: &str,
        owner: &Arc<()>,
        project: OpenProject,
    ) -> Result<u64, String> {
        if !self.is_live(label, owner) {
            return Err("mcp: the owning page closed or reloaded".into());
        }
        if self
            .entries
            .values()
            .filter(|(window, _)| window == label)
            .count()
            >= 64
        {
            return Err("mcp: too many active project runs in this window".into());
        }
        self.next = self
            .next
            .checked_add(1)
            .ok_or("mcp: run handles exhausted")?;
        self.entries.insert(self.next, (label.into(), project));
        Ok(self.next)
    }
    pub fn remove(&mut self, label: &str, id: u64) {
        if self
            .entries
            .get(&id)
            .is_some_and(|(window, _)| window == label)
        {
            self.entries.remove(&id);
        }
    }
    pub fn close(&mut self) {
        self.closed = true;
        self.owners.clear();
        self.entries.clear();
    }
    pub fn release_window(&mut self, label: &str) {
        self.owners.remove(label);
        self.entries.retain(|_, (owner, _)| owner != label);
    }
    pub fn projects(&self, label: &str) -> Vec<OpenProject> {
        let mut projects = HashMap::new();
        for (_, project) in self.entries.values().filter(|(owner, _)| owner == label) {
            projects
                .entry(project.key.clone())
                .or_insert_with(|| project.clone());
        }
        projects.into_values().collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn project(key: &str) -> OpenProject {
        OpenProject {
            real: key.into(),
            key: key.into(),
            root: key.into(),
            workspace: Default::default(),
        }
    }
    #[test]
    fn shared_project_survives_until_its_last_run_and_is_window_scoped() {
        let mut leases = Leases::default();
        let owner = leases.owner("a");
        let first = leases.insert("a", &owner, project("/p")).unwrap();
        let second = leases.insert("a", &owner, project("/p")).unwrap();
        leases.remove("b", first);
        assert_eq!(leases.projects("a").len(), 1);
        leases.remove("a", first);
        assert_eq!(leases.projects("a").len(), 1);
        leases.remove("a", second);
        assert!(leases.projects("a").is_empty());
    }
    #[test]
    fn capacity_is_per_window_and_shutdown_revokes_even_pending_starts() {
        let mut leases = Leases::default();
        let owner = leases.owner("a");
        let mut ids = Vec::new();
        for _ in 0..64 {
            ids.push(leases.insert("a", &owner, project("/p")).unwrap());
        }
        assert!(leases.insert("a", &owner, project("/p")).is_err());
        let other = leases.owner("b");
        assert!(leases.insert("b", &other, project("/q")).is_ok());
        leases.remove("a", ids[0]);
        assert!(leases.insert("a", &owner, project("/p")).is_ok());
        leases.close();
        assert!(leases.all_projects().is_empty());
        assert!(!leases.is_live("a", &owner));
        let after_shutdown = leases.owner("a");
        assert!(leases.insert("a", &after_shutdown, project("/p")).is_err());
    }
    #[test]
    fn reload_revokes_pending_leases_and_old_release_cannot_touch_new_runs() {
        let mut leases = Leases::default();
        let old = leases.owner("a");
        leases.release_window("a");
        let new = leases.owner("a");
        assert!(leases.insert("a", &old, project("/p")).is_err());
        let id = leases.insert("a", &new, project("/q")).unwrap();
        leases.remove("a", id + 1);
        assert_eq!(leases.projects("a")[0].key, "/q");
        leases.release_window("a");
        assert!(leases.projects("a").is_empty());
    }
}
