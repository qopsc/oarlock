//! Per-page run leases. Navigation preserves them; reload revokes pending opens.
use crate::modules::project_trust::OpenProject;
use std::collections::HashMap;
use std::sync::Arc;
/// One agent turn. It exists from `ai_run_begin` to `ai_run_end`, a Stop of its chat, or a reload.
pub(super) struct Record {
    window: String,
    chat_id: String,
    project: Option<OpenProject>,
}
#[derive(Default)]
pub(super) struct Leases {
    owners: HashMap<String, Arc<()>>,
    runs: HashMap<String, Record>,
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
    pub fn begin_run(
        &mut self,
        label: &str,
        owner: &Arc<()>,
        run_id: &str,
        chat_id: &str,
    ) -> Result<(), String> {
        if !self.is_live(label, owner) {
            return Err("mcp: the owning page closed or reloaded".into());
        }
        if self.runs.contains_key(run_id) {
            return Err("mcp: this run is already registered".into());
        }
        if self.runs.values().filter(|r| r.window == label).count() >= 64 {
            return Err("mcp: too many active runs in this window".into());
        }
        self.runs.insert(
            run_id.into(),
            Record {
                window: label.into(),
                chat_id: chat_id.into(),
                project: None,
            },
        );
        Ok(())
    }
    /// Publishes (or clears) the run's project. A run that ended, was revoked, or belongs to a
    /// reloaded page cannot gain one.
    pub fn set_run_project(
        &mut self,
        label: &str,
        owner: &Arc<()>,
        run_id: &str,
        project: Option<OpenProject>,
    ) -> Result<(), String> {
        if !self.is_live(label, owner) {
            return Err("mcp: the owning page closed or reloaded".into());
        }
        match self.runs.get_mut(run_id) {
            Some(record) if record.window == label => {
                record.project = project;
                Ok(())
            }
            _ => Err("mcp: this run has ended".into()),
        }
    }
    /// Whether the run held a project.
    pub fn end_run(&mut self, label: &str, run_id: &str) -> bool {
        if self.runs.get(run_id).is_some_and(|r| r.window == label) {
            return self
                .runs
                .remove(run_id)
                .is_some_and(|record| record.project.is_some());
        }
        false
    }
    /// Stop: every record of the chat in every window. Whether one held a project.
    pub fn revoke_chat(&mut self, chat_id: &str) -> bool {
        let mut held = false;
        self.runs.retain(|_, record| {
            if record.chat_id == chat_id {
                held |= record.project.is_some();
                false
            } else {
                true
            }
        });
        held
    }
    #[cfg(test)]
    pub fn run_count(&self, chat_id: &str) -> usize {
        self.runs.values().filter(|r| r.chat_id == chat_id).count()
    }
    pub fn all_projects(&self) -> Vec<OpenProject> {
        let mut projects = HashMap::new();
        for project in self.runs.values().filter_map(|r| r.project.as_ref()) {
            projects
                .entry(project.key.clone())
                .or_insert_with(|| project.clone());
        }
        projects.into_values().collect()
    }
    pub fn close(&mut self) {
        self.closed = true;
        self.owners.clear();
        self.runs.clear();
    }
    pub fn release_window(&mut self, label: &str) {
        self.owners.remove(label);
        self.runs.retain(|_, record| record.window != label);
    }
    pub fn projects(&self, label: &str) -> Vec<OpenProject> {
        let mut projects = HashMap::new();
        for project in self
            .runs
            .values()
            .filter(|r| r.window == label)
            .filter_map(|r| r.project.as_ref())
        {
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
    fn page_reload_revokes_records_and_pending_starts() {
        let mut leases = Leases::default();
        let old = leases.owner("a");
        leases.begin_run("a", &old, "run1", "chat").unwrap();
        leases
            .set_run_project("a", &old, "run1", Some(project("/p")))
            .unwrap();
        leases.release_window("a");
        assert!(leases.projects("a").is_empty());
        assert_eq!(leases.run_count("chat"), 0);
        let new = leases.owner("a");
        assert!(leases.begin_run("a", &old, "run2", "chat").is_err());
        assert!(leases
            .set_run_project("a", &old, "run1", Some(project("/p")))
            .is_err());
        leases.begin_run("a", &new, "run3", "chat").unwrap();
        assert!(!leases.end_run("a", "run1"));
        assert_eq!(leases.run_count("chat"), 1);
    }
    #[test]
    fn stop_revokes_every_record_of_the_chat_in_every_window_and_leaves_other_chats() {
        let mut leases = Leases::default();
        let (a, b) = (leases.owner("a"), leases.owner("b"));
        leases.begin_run("a", &a, "r1", "chat").unwrap();
        leases.begin_run("b", &b, "r2", "chat").unwrap();
        leases.begin_run("a", &a, "r3", "other").unwrap();
        leases
            .set_run_project("b", &b, "r2", Some(project("/p")))
            .unwrap();
        assert!(leases.revoke_chat("chat"));
        assert_eq!(leases.run_count("chat"), 0);
        assert_eq!(leases.run_count("other"), 1);
        assert!(leases.projects("b").is_empty());
        assert!(leases
            .set_run_project("b", &b, "r2", Some(project("/p")))
            .is_err());
    }
    #[test]
    fn a_foreign_window_cannot_end_or_open_another_windows_run() {
        let mut leases = Leases::default();
        let (a, b) = (leases.owner("a"), leases.owner("b"));
        leases.begin_run("a", &a, "r1", "chat").unwrap();
        assert!(leases
            .set_run_project("b", &b, "r1", Some(project("/p")))
            .is_err());
        leases.end_run("b", "r1");
        assert_eq!(leases.run_count("chat"), 1);
        leases.end_run("a", "r1");
        assert_eq!(leases.run_count("chat"), 0);
        assert!(leases
            .set_run_project("a", &a, "r1", Some(project("/p")))
            .is_err());
    }
    #[test]
    fn run_capacity_is_per_window_and_counts_runs_without_projects() {
        let mut leases = Leases::default();
        let a = leases.owner("a");
        for n in 0..64 {
            leases.begin_run("a", &a, &format!("r{n}"), "chat").unwrap();
        }
        assert!(leases.begin_run("a", &a, "extra", "chat").is_err());
        let b = leases.owner("b");
        assert!(leases.begin_run("b", &b, "other", "chat").is_ok());
        leases.end_run("a", "r0");
        assert!(leases.begin_run("a", &a, "extra", "chat").is_ok());
    }
}
