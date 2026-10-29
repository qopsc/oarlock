//! App-wide ordering for clipboard commits. Preparation never owns the OS
//! clipboard lock. Page retirement and cancellation only touch small metadata.
use super::net::page::NetworkPages;
use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use tauri::{Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Clone)]
struct Ticket {
    id: String,
    window: String,
    page: String,
}
#[derive(Default)]
struct Order {
    next: u64,
    latest: [Option<Ticket>; 2],
    sequences: HashMap<(String, String, bool), u64>,
}
#[derive(Default)]
pub struct ClipboardWrites {
    order: Mutex<Order>,
    commits: [Mutex<()>; 2],
}
impl ClipboardWrites {
    fn begin(
        &self,
        window: &str,
        page: &str,
        sequence: u64,
        primary: bool,
    ) -> Result<String, String> {
        let mut order = self.order.lock().unwrap_or_else(PoisonError::into_inner);
        let key = (window.to_owned(), page.to_owned(), primary);
        if sequence <= *order.sequences.get(&key).unwrap_or(&0) {
            return Err("Clipboard write was superseded by a newer request".into());
        }
        order.next = order
            .next
            .checked_add(1)
            .ok_or("Clipboard sequence exhausted")?;
        let id = order.next.to_string();
        order.sequences.insert(key, sequence);
        order.latest[usize::from(primary)] = Some(Ticket {
            id: id.clone(),
            window: window.into(),
            page: page.into(),
        });
        Ok(id)
    }
    fn matches(ticket: &Ticket, window: &str, page: &str, id: &str) -> bool {
        ticket.id == id && ticket.window == window && ticket.page == page
    }
    pub fn check(&self, window: &str, page: &str, id: &str, primary: bool) -> Result<(), String> {
        let order = self.order.lock().unwrap_or_else(PoisonError::into_inner);
        if order.latest[usize::from(primary)]
            .as_ref()
            .is_some_and(|t| Self::matches(t, window, page, id))
        {
            Ok(())
        } else {
            Err("Clipboard write was cancelled or superseded".into())
        }
    }
    fn take(&self, window: &str, page: &str, id: &str, primary: bool) -> Result<(), String> {
        let mut order = self.order.lock().unwrap_or_else(PoisonError::into_inner);
        let slot = &mut order.latest[usize::from(primary)];
        if !slot
            .as_ref()
            .is_some_and(|t| Self::matches(t, window, page, id))
        {
            return Err("Clipboard write was cancelled or superseded".into());
        }
        *slot = None;
        Ok(())
    }
    fn cancel(&self, window: &str, page: &str, id: &str) {
        let mut order = self.order.lock().unwrap_or_else(PoisonError::into_inner);
        for slot in &mut order.latest {
            if slot
                .as_ref()
                .is_some_and(|t| Self::matches(t, window, page, id))
            {
                *slot = None;
            }
        }
    }
    pub fn release_window(&self, window: &str) {
        let mut order = self.order.lock().unwrap_or_else(PoisonError::into_inner);
        for slot in &mut order.latest {
            if slot.as_ref().is_some_and(|t| t.window == window) {
                *slot = None;
            }
        }
        order.sequences.retain(|(owner, _, _), _| owner != window);
    }
    /// Called on a blocking worker. Once taken, the OS commit is irrevocable;
    /// newer commits wait for it, while admission/close/cancel remain nonblocking.
    pub fn commit(
        &self,
        pages: &NetworkPages,
        window: &str,
        page: &str,
        id: &str,
        primary: bool,
        write: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let _commit = self.commits[usize::from(primary)]
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        pages.with_page(window, page, || self.take(window, page, id, primary))?;
        write()
    }
}
#[tauri::command]
pub fn clipboard_write_begin(
    window: tauri::WebviewWindow,
    pages: State<'_, NetworkPages>,
    state: State<'_, ClipboardWrites>,
    page_generation: String,
    sequence: u64,
    primary: bool,
) -> Result<String, String> {
    pages.with_page(window.label(), &page_generation, || {
        state.begin(window.label(), &page_generation, sequence, primary)
    })
}
#[tauri::command]
pub fn clipboard_write_cancel(
    window: tauri::WebviewWindow,
    pages: State<'_, NetworkPages>,
    state: State<'_, ClipboardWrites>,
    page_generation: String,
    ticket: String,
) -> Result<(), String> {
    pages.with_page(window.label(), &page_generation, || {
        state.cancel(window.label(), &page_generation, &ticket);
        Ok(())
    })
}
#[tauri::command]
pub async fn clipboard_text_write(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    page_generation: String,
    ticket: String,
    text: String,
    primary: bool,
) -> Result<(), String> {
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<ClipboardWrites>().commit(
            &app.state::<NetworkPages>(),
            &label,
            &page_generation,
            &ticket,
            primary,
            || {
                if primary {
                    app.state::<super::primary_selection::PrimarySelection>()
                        .write_now(text)
                } else {
                    app.clipboard().write_text(text).map_err(|e| e.to_string())
                }
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn newer_windows_supersede_preparation_and_late_page_sequences() {
        let state = ClipboardWrites::default();
        let old = state.begin("a", "page-a", 1, false).unwrap();
        let new = state.begin("b", "page-b", 1, false).unwrap();
        assert!(state.check("a", "page-a", &old, false).is_err());
        assert!(state.check("b", "page-b", &new, false).is_ok());
        assert!(state.begin("a", "page-a", 1, false).is_err());
        assert!(state.check("b", "page-b", &new, false).is_ok());
    }
    #[test]
    fn cancellation_is_exact_and_commits_are_single_use() {
        let state = ClipboardWrites::default();
        let id = state.begin("a", "p", 1, false).unwrap();
        state.cancel("other", "p", &id);
        assert!(state.check("a", "p", &id, false).is_ok());
        state.cancel("a", "p", &id);
        assert!(state.check("a", "p", &id, false).is_err());
        let id = state.begin("a", "p", 2, false).unwrap();
        assert!(state.take("a", "p", &id, false).is_ok());
        assert!(state.take("a", "p", &id, false).is_err());
    }
    #[test]
    fn page_retirement_cancels_writes_without_affecting_other_selections() {
        let state = ClipboardWrites::default();
        let pages = NetworkPages::default();
        pages.begin("a", || {}).unwrap();
        let page = pages.finish("a").unwrap();
        let old = state.begin("a", &page, 1, false).unwrap();
        let primary = state.begin("b", "p", 1, true).unwrap();
        pages.close("a", || state.release_window("a"));
        assert!(state
            .commit(&pages, "a", &page, &old, false, || panic!("retired commit"))
            .is_err());
        assert!(state.check("b", "p", &primary, true).is_ok());
        assert!(state
            .order
            .lock()
            .unwrap()
            .sequences
            .keys()
            .all(|(w, _, _)| w != "a"));
    }
    #[test]
    fn slow_os_commit_does_not_block_retirement_and_newer_writes_win() {
        use std::{
            sync::{mpsc, Arc},
            time::Duration,
        };
        let state = Arc::new(ClipboardWrites::default());
        let pages = Arc::new(NetworkPages::default());
        pages.begin("a", || {}).unwrap();
        let pa = pages.finish("a").unwrap();
        pages.begin("b", || {}).unwrap();
        let pb = pages.finish("b").unwrap();
        let first = state.begin("a", &pa, 1, false).unwrap();
        let (entered, entering) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let writes = Arc::new(Mutex::new(Vec::new()));
        let worker = std::thread::spawn({
            let state = state.clone();
            let pages = pages.clone();
            let writes = writes.clone();
            move || {
                state.commit(&pages, "a", &pa, &first, false, || {
                    entered.send(()).unwrap();
                    released.recv().unwrap();
                    writes.lock().unwrap().push(1);
                    Ok(())
                })
            }
        });
        entering.recv_timeout(Duration::from_secs(2)).unwrap();
        let second = state.begin("b", &pb, 1, false).unwrap();
        let third = state.begin("b", &pb, 2, false).unwrap();
        let (closed, closing) = mpsc::channel();
        let retire = std::thread::spawn({
            let state = state.clone();
            let pages = pages.clone();
            move || {
                pages.close("a", || state.release_window("a"));
                closed.send(()).unwrap();
            }
        });
        let retired = closing.recv_timeout(Duration::from_secs(2));
        release.send(()).unwrap();
        worker.join().unwrap().unwrap();
        retire.join().unwrap();
        assert!(retired.is_ok(), "retirement waited for the OS clipboard");
        assert!(state
            .commit(&pages, "b", &pb, &second, false, || panic!(
                "superseded commit"
            ))
            .is_err());
        state
            .commit(&pages, "b", &pb, &third, false, || {
                writes.lock().unwrap().push(3);
                Ok(())
            })
            .unwrap();
        assert_eq!(*writes.lock().unwrap(), vec![1, 3]);
    }
}
