//! Pure quit protocol. Confirmation leaves windows editable; final verification
//! requires every participant to seal its editor before answering.
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(super) struct Request {
    pub round: u64,
    pub ticket: u64,
    pub verify: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Action {
    Ask(String, Request),
    Verify(Vec<String>, Request),
    Resume(u64, Option<u64>),
    Exit,
}
#[derive(Debug)]
struct Verification {
    ticket: u64,
    waiting: HashSet<String>,
}
pub(super) struct QuitRound {
    pub id: u64,
    queue: VecDeque<String>,
    pub asking: Option<(String, u64)>,
    approvals: HashMap<String, u64>,
    verification: Option<Verification>,
    ticket: u64,
    pub ended: bool,
}
impl QuitRound {
    pub fn new(id: u64, queue: VecDeque<String>) -> Self {
        Self {
            id,
            queue,
            asking: None,
            approvals: HashMap::new(),
            verification: None,
            ticket: 0,
            ended: false,
        }
    }
    pub fn next(&mut self) -> Vec<Action> {
        if self.ended || self.asking.is_some() || self.verification.is_some() {
            return vec![];
        }
        self.ticket += 1;
        if let Some(label) = self.queue.pop_front() {
            self.asking = Some((label.clone(), self.ticket));
            vec![Action::Ask(
                label,
                Request {
                    round: self.id,
                    ticket: self.ticket,
                    verify: false,
                },
            )]
        } else if self.approvals.is_empty() {
            self.ended = true;
            vec![Action::Exit]
        } else {
            let mut labels: Vec<_> = self.approvals.keys().cloned().collect();
            labels.sort();
            self.verification = Some(Verification {
                ticket: self.ticket,
                waiting: labels.iter().cloned().collect(),
            });
            vec![Action::Verify(
                labels,
                Request {
                    round: self.id,
                    ticket: self.ticket,
                    verify: true,
                },
            )]
        }
    }
    pub fn answer(&mut self, label: &str, ticket: u64, ok: bool) -> Vec<Action> {
        if self.ended {
            return vec![];
        }
        if let Some(verification) = &mut self.verification {
            if verification.ticket != ticket || !verification.waiting.contains(label) {
                return vec![];
            }
            if !ok {
                return self.invalidate(label);
            }
            verification.waiting.remove(label);
            if verification.waiting.is_empty() {
                self.ended = true;
                return vec![Action::Exit];
            }
            return vec![];
        }
        if self
            .asking
            .as_ref()
            .is_none_or(|(asked, id)| asked != label || *id != ticket)
        {
            return vec![];
        }
        if !ok {
            return self.cancel();
        }
        self.asking = None;
        self.approvals.insert(label.to_owned(), ticket);
        self.next()
    }
    pub fn changed(&mut self, label: &str, ticket: u64) -> Vec<Action> {
        if self.ended {
            return vec![];
        }
        // An edit can overtake its approval IPC. Retire that request too;
        // its delayed acknowledgement must not approve the newer document.
        if self
            .asking
            .as_ref()
            .is_some_and(|(asked, id)| asked == label && *id == ticket)
        {
            self.asking = None;
        } else if self.approvals.get(label) != Some(&ticket) {
            return vec![];
        }
        self.invalidate(label)
    }
    fn invalidate(&mut self, label: &str) -> Vec<Action> {
        self.approvals.remove(label);
        let mut actions = Vec::new();
        if let Some(verification) = self.verification.take() {
            actions.push(Action::Resume(self.id, Some(verification.ticket)));
        }
        if !self.queue.iter().any(|item| item == label) {
            self.queue.push_back(label.to_owned());
        }
        actions.extend(self.next());
        actions
    }
    pub fn verifying(&self, ticket: u64) -> bool {
        !self.ended
            && self
                .verification
                .as_ref()
                .is_some_and(|v| v.ticket == ticket)
    }
    pub fn cancel(&mut self) -> Vec<Action> {
        if self.ended {
            return vec![];
        }
        self.ended = true;
        vec![Action::Resume(self.id, None)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn round() -> QuitRound {
        QuitRound::new(1, VecDeque::from(["a".into(), "b".into()]))
    }
    #[test]
    fn every_window_must_confirm_then_seal_before_exit() {
        let mut r = round();
        assert!(
            matches!(&r.next()[0], Action::Ask(label, Request { ticket: 1, .. }) if label == "a")
        );
        assert!(matches!(&r.answer("a", 1, true)[0], Action::Ask(label, _) if label == "b"));
        assert!(matches!(
            &r.answer("b", 2, true)[0],
            Action::Verify(_, Request { ticket: 3, .. })
        ));
        assert!(r.answer("a", 3, true).is_empty());
        assert_eq!(r.answer("b", 3, true), vec![Action::Exit]);
    }
    #[test]
    fn edits_while_another_window_confirms_requeue_only_the_changed_window() {
        let mut r = round();
        r.next();
        r.answer("a", 1, true);
        assert!(r.changed("a", 1).is_empty());
        assert!(r.changed("a", 1).is_empty());
        assert!(
            matches!(&r.answer("b", 2, true)[0], Action::Ask(label, Request { ticket: 3, .. }) if label == "a")
        );
        assert!(r.answer("a", 1, true).is_empty());
        assert!(matches!(&r.answer("a", 3, true)[0], Action::Verify(_, _)));
    }
    #[test]
    fn an_invalidation_that_overtakes_approval_retires_the_old_ticket() {
        let mut r = round();
        r.next();
        assert!(matches!(&r.changed("a", 1)[0], Action::Ask(label, _) if label == "b"));
        assert!(r.answer("a", 1, true).is_empty());
        assert!(matches!(&r.answer("b", 2, true)[0], Action::Ask(label, _) if label == "a"));
    }
    #[test]
    fn stale_verification_releases_all_seals_and_requires_confirmation_again() {
        let mut r = round();
        r.next();
        r.answer("a", 1, true);
        r.answer("b", 2, true);
        r.answer("a", 3, true);
        let actions = r.answer("b", 3, false);
        assert_eq!(actions[0], Action::Resume(1, Some(3)));
        assert!(
            matches!(&actions[1], Action::Ask(label, Request { ticket: 4, .. }) if label == "b")
        );
        assert!(r.answer("b", 3, true).is_empty());
        r.answer("b", 4, true);
        assert!(r.answer("a", 3, true).is_empty());
        assert!(r.answer("a", 5, true).is_empty());
        assert_eq!(r.answer("b", 5, true), vec![Action::Exit]);
    }
    #[test]
    fn cancel_and_membership_changes_never_accept_late_votes() {
        let mut r = round();
        r.next();
        r.answer("a", 1, true);
        r.answer("b", 2, true);
        assert!(r.verifying(3));
        assert_eq!(r.cancel(), vec![Action::Resume(1, None)]);
        assert!(!r.verifying(3));
        assert!(r.answer("a", 3, true).is_empty());
        assert!(r.answer("b", 3, true).is_empty());
        assert!(r.next().is_empty());
    }
    #[test]
    fn wrong_windows_and_stale_tickets_cannot_approve_or_invalidate() {
        let mut r = round();
        r.next();
        assert!(r.answer("b", 1, true).is_empty());
        assert!(r.changed("b", 1).is_empty());
        r.answer("a", 1, true);
        r.answer("b", 2, true);
        assert!(r.answer("outsider", 3, true).is_empty());
        assert!(r.changed("a", 9).is_empty());
        assert_eq!(r.changed("a", 1)[0], Action::Resume(1, Some(3)));
    }
}
