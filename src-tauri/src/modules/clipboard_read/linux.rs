//! GTK snapshots use selection notifications on X11 and the requesting
//! window's keyboard-focus lifetime on Wayland.
use super::*;
use gtk::{gdk, glib, prelude::*};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(1);
fn next() -> u64 {
    NEXT.fetch_add(1, Ordering::Relaxed)
}
#[derive(Clone)]
struct Tracker {
    clipboard: gtk::Clipboard,
    revision: Rc<Cell<u64>>,
    wayland: bool,
}
thread_local! { static TRACKERS: RefCell<[Option<Tracker>; 2]> = const { RefCell::new([None, None]) }; }
fn tracker(primary: bool) -> Result<Tracker, String> {
    TRACKERS.with(|slots| {
        let mut slots = slots.borrow_mut();
        if let Some(tracker) = &slots[usize::from(primary)] {
            return Ok(tracker.clone());
        }
        let clipboard = gtk::Clipboard::get(if primary {
            &gdk::SELECTION_PRIMARY
        } else {
            &gdk::SELECTION_CLIPBOARD
        });
        let display = clipboard.display().ok_or("Clipboard display unavailable")?;
        let wayland = display.type_().name() == "GdkWaylandDisplay";
        if !wayland && !display.supports_selection_notification() {
            return Err("This display cannot verify clipboard changes.".into());
        }
        let revision = Rc::new(Cell::new(next()));
        let changed = revision.clone();
        clipboard.connect_local("owner-change", false, move |_| {
            changed.set(next());
            None
        });
        let tracker = Tracker {
            clipboard,
            revision,
            wayland,
        };
        slots[usize::from(primary)] = Some(tracker.clone());
        Ok(tracker)
    })
}
#[derive(Clone)]
struct FocusOwner {
    window: glib::WeakRef<gtk::Window>,
    version: Rc<RefCell<focus::FocusVersion>>,
}
thread_local! { static FOCUS: RefCell<HashMap<usize, FocusOwner>> = RefCell::new(HashMap::new()); }
fn focus_owner(app: &tauri::AppHandle, label: &str) -> Result<FocusOwner, String> {
    let window = app
        .get_webview_window(label)
        .ok_or("Clipboard window closed")?
        .gtk_window()
        .map_err(|e| e.to_string())?
        .upcast::<gtk::Window>();
    Ok(track_focus(window))
}
fn track_focus(window: gtk::Window) -> FocusOwner {
    let id = window.as_ptr() as usize;
    FOCUS.with(|owners| {
        let mut owners = owners.borrow_mut();
        if let Some(owner) = owners.get(&id) {
            return owner.clone();
        }
        let version = Rc::new(RefCell::new(focus::FocusVersion::new(
            next(),
            window.has_toplevel_focus(),
        )));
        let changed = version.clone();
        window.connect_has_toplevel_focus_notify(move |window| {
            changed
                .borrow_mut()
                .update(next(), window.has_toplevel_focus());
        });
        let closed = version.clone();
        window.connect_destroy(move |_| {
            closed.borrow_mut().close();
            FOCUS.with(|owners| {
                owners.borrow_mut().remove(&id);
            });
        });
        let owner = FocusOwner {
            window: window.downgrade(),
            version,
        };
        owners.insert(id, owner.clone());
        owner
    })
}
fn revision(tracker: &Tracker, focus: Option<&FocusOwner>) -> Result<String, String> {
    let clipboard = tracker.revision.get();
    match focus {
        Some(owner) => {
            let window = owner.window.upgrade().ok_or(focus::FOCUS_REQUIRED)?;
            owner
                .version
                .borrow_mut()
                .update(next(), window.has_toplevel_focus());
            owner.version.borrow().revision(clipboard)
        }
        None => Ok(clipboard.to_string()),
    }
}
struct Pending {
    tracker: Tracker,
    start: String,
    focus: Option<FocusOwner>,
    focus_signal: Option<glib::SignalHandlerId>,
    destroy_signal: Option<glib::SignalHandlerId>,
    signal: Option<glib::SignalHandlerId>,
    timer: Option<glib::SourceId>,
    sender: Option<tokio::sync::oneshot::Sender<Result<Raw, String>>>,
}
struct Pixels {
    bytes: glib::Bytes,
    width: usize,
    height: usize,
    stride: usize,
    channels: usize,
}
struct Raw {
    revision: String,
    text: String,
    image: ImageStatus,
    pixels: Option<Pixels>,
    focus_required: bool,
}
fn finish(pending: &Rc<RefCell<Pending>>, result: Result<Raw, String>) {
    let mut state = pending.borrow_mut();
    let result = revision(&state.tracker, state.focus.as_ref())
        .and_then(|current| unchanged(&state.start, current))
        .and(result);
    if let Some(window) = state.focus.as_ref().and_then(|f| f.window.upgrade()) {
        if let Some(signal) = state.focus_signal.take() {
            window.disconnect(signal);
        }
        if let Some(signal) = state.destroy_signal.take() {
            window.disconnect(signal);
        }
    }
    if let Some(signal) = state.signal.take() {
        state.tracker.clipboard.disconnect(signal);
    }
    if let Some(timer) = state.timer.take() {
        timer.remove();
    }
    if let Some(sender) = state.sender.take() {
        let _ = sender.send(result);
    }
}
pub async fn capture(
    app: &tauri::AppHandle,
    label: &str,
    page: &str,
    primary: bool,
    image: ImageRequest,
    known: Option<String>,
) -> Result<Snapshot, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let owner = (app.clone(), label.to_owned(), page.to_owned());
    app.run_on_main_thread(move || {
        if let Err(error) = owner
            .0
            .state::<NetworkPages>()
            .with_page(&owner.1, &owner.2, || Ok(()))
        {
            let _ = tx.send(Err(error));
            return;
        }
        start(&owner.0, &owner.1, primary, image, known, tx);
    })
    .map_err(|e| e.to_string())?;
    let raw = rx.await.map_err(|_| "Clipboard capture cancelled")??;
    app.state::<NetworkPages>()
        .with_page(label, page, || Ok(()))?;
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        let png = match raw.pixels {
            Some(pixels) => {
                let rgba = packed_rgba(
                    &pixels.bytes,
                    pixels.width,
                    pixels.height,
                    pixels.stride,
                    pixels.channels,
                )?;
                encode_image(&rgba, pixels.width as u32, pixels.height as u32)?
            }
            None => Vec::new(),
        };
        Ok::<_, String>(Snapshot {
            header: Header {
                revision: raw.revision,
                text: Some(raw.text),
                image: raw.image,
                focus_required: raw.focus_required,
            },
            png,
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let owner = (app.clone(), label.to_owned());
    app.run_on_main_thread(move || {
        let _ = tx.send((|| {
            let tracker = tracker(primary)?;
            let focus = if tracker.wayland {
                Some(focus_owner(&owner.0, &owner.1)?)
            } else {
                None
            };
            revision(&tracker, focus.as_ref())
        })());
    })
    .map_err(|e| e.to_string())?;
    unchanged(
        &snapshot.header.revision,
        rx.await
            .map_err(|_| "Clipboard version check cancelled")??,
    )?;
    Ok(snapshot)
}
fn start(
    app: &tauri::AppHandle,
    label: &str,
    primary: bool,
    image: ImageRequest,
    known: Option<String>,
    sender: tokio::sync::oneshot::Sender<Result<Raw, String>>,
) {
    let tracker = match tracker(primary) {
        Ok(t) => t,
        Err(e) => {
            let _ = sender.send(Err(e));
            return;
        }
    };
    let clipboard = tracker.clipboard.clone();
    let focus_required = tracker.wayland;
    let focus = if tracker.wayland {
        match focus_owner(app, label) {
            Ok(focus) => Some(focus),
            Err(error) => {
                let _ = sender.send(Err(error));
                return;
            }
        }
    } else {
        None
    };
    let start = match revision(&tracker, focus.as_ref()) {
        Ok(revision) => revision,
        Err(error) => {
            let _ = sender.send(Err(error));
            return;
        }
    };
    let pending = Rc::new(RefCell::new(Pending {
        tracker,
        start: start.clone(),
        focus: focus.clone(),
        focus_signal: None,
        destroy_signal: None,
        signal: None,
        timer: None,
        sender: Some(sender),
    }));
    observe(&pending);
    clipboard.request_text(move |clipboard, text| {
        if pending.borrow().sender.is_none() {
            return;
        }
        let text = text.map(ToString::to_string).unwrap_or_default();
        if primary {
            if let Err(error) = crate::modules::primary_selection::check_size(text.len()) {
                finish(&pending, Err(error));
                return;
            }
        }
        let revision = start;
        if !image.wanted(&text, primary) || known.as_deref() == Some(revision.as_str()) {
            let status = if image.wanted(&text, primary) {
                ImageStatus::Reuse
            } else {
                ImageStatus::Omitted
            };
            finish(
                &pending,
                Ok(Raw {
                    revision,
                    text,
                    image: status,
                    pixels: None,
                    focus_required,
                }),
            );
            return;
        }
        clipboard.request_image(move |_, image| {
            if pending.borrow().sender.is_none() {
                return;
            }
            let captured = (|| {
                let pixels = match image {
                    None => None,
                    Some(image) => {
                        let (w, h) = (image.width(), image.height());
                        if w <= 0
                            || h <= 0
                            || w > 16_384
                            || h > 16_384
                            || i64::from(w) * i64::from(h) * 4 > 512 * 1024 * 1024
                        {
                            return Err("Clipboard image is too large or invalid".into());
                        }
                        let (w, h) = (w as usize, h as usize);
                        let (channels, stride) =
                            (image.n_channels() as usize, image.rowstride() as usize);
                        let bytes = image.read_pixel_bytes();
                        if ![3, 4].contains(&channels)
                            || stride < w * channels
                            || bytes.len() < stride * (h - 1) + w * channels
                        {
                            return Err("Clipboard image pixels are incomplete".into());
                        }
                        Some(Pixels {
                            bytes,
                            width: w,
                            height: h,
                            stride,
                            channels,
                        })
                    }
                };
                Ok(Raw {
                    revision,
                    text,
                    image: if pixels.is_some() {
                        ImageStatus::Png
                    } else {
                        ImageStatus::Empty
                    },
                    pixels,
                    focus_required,
                })
            })();
            finish(&pending, captured);
        });
    });
}

fn observe(pending: &Rc<RefCell<Pending>>) {
    let (clipboard, focus) = {
        let state = pending.borrow();
        (state.tracker.clipboard.clone(), state.focus.clone())
    };
    let weak = Rc::downgrade(pending);
    pending.borrow_mut().signal = Some(clipboard.connect_local("owner-change", false, move |_| {
        if let Some(pending) = weak.upgrade() {
            finish(&pending, Err(CHANGED.into()));
        }
        None
    }));
    if let Some(window) = focus.as_ref().and_then(|f| f.window.upgrade()) {
        let weak = Rc::downgrade(pending);
        pending.borrow_mut().focus_signal =
            Some(window.connect_has_toplevel_focus_notify(move |window| {
                if window.has_toplevel_focus() {
                    return;
                }
                if let Some(pending) = weak.upgrade() {
                    finish(&pending, Err(focus::FOCUS_REQUIRED.into()));
                }
            }));
        let weak = Rc::downgrade(pending);
        pending.borrow_mut().destroy_signal = Some(window.connect_destroy(move |_| {
            if let Some(pending) = weak.upgrade() {
                finish(&pending, Err(focus::FOCUS_REQUIRED.into()));
            }
        }));
    }
    let timeout = pending.clone();
    pending.borrow_mut().timer = Some(glib::timeout_add_local_once(
        std::time::Duration::from_secs(5),
        move || {
            timeout.borrow_mut().timer.take();
            finish(
                &timeout,
                Err("Clipboard capture timed out. Try pasting again.".into()),
            );
        },
    ));
}

#[cfg(test)]
#[path = "linux_tests.rs"]
mod tests;
