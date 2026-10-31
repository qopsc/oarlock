//! Orders the initial portal read behind any newer change signal.
use std::cell::Cell;

#[derive(Default)]
pub(super) struct SchemeOrder(Cell<u64>);
impl SchemeOrder {
    pub(super) fn snapshot(&self) -> u64 {
        self.0.get()
    }
    pub(super) fn changed(&self) {
        self.0.set(self.0.get().wrapping_add(1));
    }
    pub(super) fn current(&self, snapshot: u64) -> bool {
        self.0.get() == snapshot
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signal_supersedes_both_initial_read_and_fallback() {
        let order = SchemeOrder::default();
        let read = order.snapshot();
        assert!(order.current(read));
        order.changed();
        assert!(!order.current(read));
        let next = order.snapshot();
        assert!(order.current(next));
        order.changed();
        assert!(!order.current(next));
    }
}
