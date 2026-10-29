//! Bounded system DNS. A caller may stop waiting, but a running OS lookup
//! retains its permit until it returns. Never detach unaccounted blocking work.
use std::{
    net::{IpAddr, ToSocketAddrs},
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{sync::Semaphore, task::JoinHandle};

const ACTIVE: usize = 8;
const QUEUED: usize = 32;
const DEADLINE: Duration = Duration::from_secs(10);
const TIMEOUT_ERROR: &str = "DNS lookup timed out after 10 seconds";

struct Resolver {
    active: Arc<Semaphore>,
    queued: Arc<Semaphore>,
}
impl Resolver {
    fn new(active: usize, queued: usize) -> Self {
        Self {
            active: Arc::new(Semaphore::new(active)),
            queued: Arc::new(Semaphore::new(queued)),
        }
    }

    async fn run(
        &self,
        lookup: impl FnOnce() -> std::io::Result<Vec<IpAddr>> + Send + 'static,
    ) -> Result<Vec<IpAddr>, String> {
        let deadline = tokio::time::Instant::now() + DEADLINE;
        tokio::time::timeout_at(deadline, async {
            let permit = match self.active.clone().try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => {
                    let queued = self.queued.clone().try_acquire_owned().map_err(|_| {
                        "DNS resolver is busy (8 active and 32 queued lookups); try again"
                            .to_owned()
                    })?;
                    let permit = self
                        .active
                        .clone()
                        .acquire_owned()
                        .await
                        .map_err(|_| "DNS resolver is unavailable".to_owned())?;
                    drop(queued);
                    permit
                }
            };
            // A permit and the timeout can become ready together. Never start
            // a queued OS lookup just because the inner future was polled first.
            if tokio::time::Instant::now() >= deadline {
                return Err(TIMEOUT_ERROR.to_owned());
            }
            let mut task = CancelQueued(tokio::task::spawn_blocking(move || {
                let _permit = permit;
                lookup()
            }));
            let result = (&mut task.0).await;
            if tokio::time::Instant::now() >= deadline {
                return Err(TIMEOUT_ERROR.to_owned());
            }
            result
                .map_err(|e| format!("dns: {e}"))?
                .map_err(|e| format!("dns: {e}"))
        })
        .await
        .map_err(|_| TIMEOUT_ERROR.to_owned())?
    }
}

// abort() removes a not-yet-started blocking task. For a running task it cannot
// kill the OS resolver; that task still owns its active permit above.
struct CancelQueued<T>(JoinHandle<T>);
impl<T> Drop for CancelQueued<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub async fn lookup(host: &str) -> Result<Vec<IpAddr>, String> {
    static RESOLVER: OnceLock<Resolver> = OnceLock::new();
    let host = host.to_owned();
    RESOLVER
        .get_or_init(|| Resolver::new(ACTIVE, QUEUED))
        .run(move || {
            (host.as_str(), 0u16)
                .to_socket_addrs()
                .map(|addresses| addresses.map(|a| a.ip()).collect())
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;
    use std::sync::{Condvar, Mutex};

    struct Held(Arc<(Mutex<bool>, Condvar)>);
    impl Held {
        fn new() -> Self {
            Self(Arc::new((Mutex::new(false), Condvar::new())))
        }
        fn lookup(&self) -> impl FnOnce() -> std::io::Result<Vec<IpAddr>> + Send + 'static {
            let held = self.0.clone();
            move || {
                let _guard = held
                    .1
                    .wait_while(held.0.lock().unwrap(), |released| !*released)
                    .unwrap();
                Ok(vec!["1.1.1.1".parse().unwrap()])
            }
        }
    }
    impl Drop for Held {
        fn drop(&mut self) {
            *self.0 .0.lock().unwrap() = true;
            self.0 .1.notify_all();
        }
    }

    #[tokio::test]
    async fn cancelled_dns_work_remains_within_the_request_budget() {
        let resolver = Resolver::new(ACTIVE, QUEUED);
        let held = Held::new();
        for _ in 0..ACTIVE {
            let lookup = held.lookup();
            let (began, started) = tokio::sync::oneshot::channel();
            let mut caller = Box::pin(resolver.run(move || {
                let _ = began.send(());
                lookup()
            }));
            assert!(caller.as_mut().now_or_never().is_none());
            started.await.unwrap();
            drop(caller);
        }
        assert_eq!(
            resolver.active.available_permits(),
            0,
            "cancelled running lookups lost their accounting"
        );
        let mut waiting = Vec::new();
        for _ in 0..QUEUED {
            let mut caller = Box::pin(
                resolver.run(|| panic!("queued lookup started while all workers were held")),
            );
            assert!(caller.as_mut().now_or_never().is_none());
            waiting.push(caller);
        }
        assert_eq!(resolver.queued.available_permits(), 0);
        assert!(resolver
            .run(|| panic!("overflow started"))
            .await
            .unwrap_err()
            .contains("busy"));
        drop(waiting);
        assert_eq!(resolver.queued.available_permits(), QUEUED);
        drop(held);
        assert_eq!(
            resolver.run(|| Ok(vec![])).await.unwrap(),
            Vec::<IpAddr>::new()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_deadline_covers_queueing_and_does_not_release_running_work() {
        let resolver = Resolver::new(1, 1);
        let held = Held::new();
        let (began, started) = tokio::sync::oneshot::channel();
        let lookup = held.lookup();
        let mut active = Box::pin(resolver.run(move || {
            let _ = began.send(());
            lookup()
        }));
        assert!(active.as_mut().now_or_never().is_none());
        started.await.unwrap();
        let mut queued = Box::pin(resolver.run(|| panic!("expired queued DNS started")));
        assert!(queued.as_mut().now_or_never().is_none());
        tokio::time::advance(DEADLINE).await;
        assert!(active.await.unwrap_err().contains("timed out"));
        assert!(queued.await.unwrap_err().contains("timed out"));
        assert_eq!(resolver.active.available_permits(), 0);
        assert_eq!(resolver.queued.available_permits(), 1);
        drop(held);
    }

    #[test]
    fn cancelling_a_task_still_in_tokios_blocking_queue_prevents_lookup() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .enable_time()
            .build()
            .unwrap();
        let held = Held::new();
        let blocker = runtime.spawn_blocking(held.lookup());
        let resolver = Resolver::new(1, 1);
        runtime.block_on(async {
            let mut cancelled =
                Box::pin(resolver.run(|| panic!("cancelled blocking task executed")));
            assert!(cancelled.as_mut().now_or_never().is_none());
            drop(cancelled);
            drop(held);
            blocker.await.unwrap().unwrap();
            // Queue a barrier behind the cancelled task before checking its permit.
            tokio::task::spawn_blocking(|| {}).await.unwrap();
            assert_eq!(resolver.active.available_permits(), 1);
        });
    }

    #[tokio::test(start_paused = true)]
    async fn a_permit_released_after_the_deadline_cannot_start_a_lookup() {
        let resolver = Resolver::new(1, 1);
        let occupied = resolver.active.clone().acquire_owned().await.unwrap();
        let mut waiting = Box::pin(resolver.run(|| panic!("expired lookup started")));
        assert!(waiting.as_mut().now_or_never().is_none());
        tokio::time::advance(DEADLINE).await;
        drop(occupied);
        assert!(waiting.await.unwrap_err().contains("timed out"));
        assert_eq!(resolver.active.available_permits(), 1);
        assert_eq!(resolver.queued.available_permits(), 1);
    }

    #[tokio::test]
    async fn resolver_errors_and_panics_release_their_slots() {
        let resolver = Resolver::new(1, 1);
        assert!(resolver
            .run(|| Err(std::io::Error::other("fixture DNS error")))
            .await
            .unwrap_err()
            .contains("fixture DNS error"));
        assert!(resolver
            .run(|| panic!("fixture resolver panic"))
            .await
            .unwrap_err()
            .contains("dns:"));
        assert_eq!(resolver.active.available_permits(), 1);
        assert_eq!(
            resolver
                .run(|| Ok(vec!["127.0.0.1".parse().unwrap()]))
                .await
                .unwrap()
                .len(),
            1
        );
    }
}
