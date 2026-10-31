use super::*;

fn pump_until(check: impl Fn() -> bool) {
    let context = glib::MainContext::default();
    for _ in 0..100 {
        while context.pending() {
            context.iteration(false);
        }
        if check() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(check(), "GTK did not deliver the expected focus transition");
}

#[test]
#[ignore = "Requires a disposable GTK display; run under xvfb-run"]
fn gtk_focus_loss_cancels_pending_capture_and_invalidates_reuse() {
    gtk::init().unwrap();
    let first = gtk::Window::new(gtk::WindowType::Toplevel);
    let second = gtk::Window::new(gtk::WindowType::Toplevel);
    first.show_all();
    second.show_all();
    first.window().unwrap().focus(0);
    pump_until(|| first.has_toplevel_focus());
    let owner = track_focus(first.clone());
    let mut tracker = tracker(false).unwrap();
    tracker.wayland = true;
    let captured = revision(&tracker, Some(&owner)).unwrap();
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    let pending = Rc::new(RefCell::new(Pending {
        tracker: tracker.clone(),
        start: captured.clone(),
        focus: Some(owner.clone()),
        focus_signal: None,
        destroy_signal: None,
        signal: None,
        timer: None,
        sender: Some(tx),
    }));
    observe(&pending);
    second.window().unwrap().focus(0);
    pump_until(|| !first.has_toplevel_focus() && pending.borrow().sender.is_none());
    assert!(rx.try_recv().unwrap().is_err());
    assert!(revision(&tracker, Some(&owner)).is_err());
    assert!(pending.borrow().timer.is_none());
    assert!(pending.borrow().signal.is_none());
    assert!(pending.borrow().focus_signal.is_none());
    assert!(pending.borrow().destroy_signal.is_none());
    first.window().unwrap().focus(0);
    pump_until(|| first.has_toplevel_focus());
    assert_ne!(revision(&tracker, Some(&owner)).unwrap(), captured);
    let second_owner = track_focus(second.clone());
    assert!(revision(&tracker, Some(&second_owner)).is_err());
    unsafe {
        first.destroy();
        second.destroy();
    }
    assert!(revision(&tracker, Some(&owner)).is_err());
    FOCUS.with(|owners| assert!(owners.borrow().is_empty()));
}

#[test]
#[ignore = "Requires a disposable headless Wayland compositor without keyboard input"]
fn wayland_background_reads_require_focus_even_without_generic_notifications() {
    gtk::init().unwrap();
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.show_all();
    let context = glib::MainContext::default();
    while context.pending() {
        context.iteration(false);
    }
    let tracker = tracker(false).unwrap();
    assert!(tracker.wayland, "Run with GDK_BACKEND=wayland");
    let owner = track_focus(window.clone());
    assert!(!window.has_toplevel_focus());
    assert!(revision(&tracker, Some(&owner)).is_err());
    unsafe {
        window.destroy();
    }
    FOCUS.with(|owners| assert!(owners.borrow().is_empty()));
}
