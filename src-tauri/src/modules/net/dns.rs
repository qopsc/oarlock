//! Bounded system DNS. A caller may stop waiting, but a running OS lookup
//! retains its permit until it returns. Never detach unaccounted blocking work.
use std::{
    collections::HashMap,
    net::{IpAddr, ToSocketAddrs},
    sync::{Arc, Mutex, OnceLock, PoisonError},
    time::Duration,
};
use tokio::{sync::Semaphore, task::JoinHandle, time::Instant};

const ACTIVE: usize = 8;
const QUEUED: usize = 32;
const DEADLINE: Duration = Duration::from_secs(10);
/// How long an answer is reused. A page with fifty badges from one host asks for it fifty
/// times at once; the answer is classified and pinned per request, so a short reuse changes
/// nothing about rebinding, it only keeps the resolver from refusing its own callers.
const ANSWER_TTL: Duration = Duration::from_secs(10);
const FAILURE_TTL: Duration = Duration::from_secs(2);
const MAX_HOSTS: usize = 256;
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

type Answer = Result<Vec<IpAddr>, String>;
type Slot = Arc<tokio::sync::Mutex<Option<(Instant, Answer)>>>;

/// One lookup per host at a time, and its answer kept briefly: callers that ask for a host
/// already being resolved wait for that answer instead of taking a resolver slot of their own.
struct Lookups {
    hosts: Mutex<HashMap<String, Slot>>,
}

impl Lookups {
    fn new() -> Self {
        Self {
            hosts: Mutex::new(HashMap::new()),
        }
    }

    fn slot(&self, host: &str) -> Slot {
        let mut hosts = self.hosts.lock().unwrap_or_else(PoisonError::into_inner);
        if hosts.len() >= MAX_HOSTS && !hosts.contains_key(host) {
            // A slot nobody holds and whose answer has expired is dead weight.
            hosts.retain(|_, slot| {
                slot.try_lock()
                    .map(|held| {
                        held.as_ref()
                            .is_some_and(|(at, answer)| fresh(*at, answer))
                    })
                    .unwrap_or(true)
            });
            if hosts.len() >= MAX_HOSTS {
                // Everything left is fresh or in use: drop the oldest answer nobody holds. If
                // every slot is in use the table passes the bound by the new host only.
                let oldest = hosts
                    .iter()
                    .filter_map(|(host, slot)| {
                        slot.try_lock()
                            .ok()
                            .map(|held| (host.clone(), held.as_ref().map(|(at, _)| *at)))
                    })
                    .min_by_key(|(_, at)| *at)
                    .map(|(host, _)| host);
                if let Some(host) = oldest {
                    hosts.remove(&host);
                }
            }
        }
        hosts.entry(host.to_owned()).or_default().clone()
    }

    async fn resolve(
        &self,
        resolver: &Resolver,
        host: &str,
        lookup: impl FnOnce() -> std::io::Result<Vec<IpAddr>> + Send + 'static,
    ) -> Answer {
        let slot = self.slot(host);
        let mut held = slot.lock().await;
        if let Some((at, answer)) = held.as_ref() {
            if fresh(*at, answer) {
                return answer.clone();
            }
        }
        let answer = resolver.run(lookup).await;
        *held = Some((Instant::now(), answer.clone()));
        answer
    }
}

fn fresh(at: Instant, answer: &Answer) -> bool {
    at.elapsed() < if answer.is_ok() { ANSWER_TTL } else { FAILURE_TTL }
}

pub async fn lookup(host: &str) -> Result<Vec<IpAddr>, String> {
    static RESOLVER: OnceLock<Resolver> = OnceLock::new();
    static LOOKUPS: OnceLock<Lookups> = OnceLock::new();
    let name = host.to_owned();
    LOOKUPS
        .get_or_init(Lookups::new)
        .resolve(
            RESOLVER.get_or_init(|| Resolver::new(ACTIVE, QUEUED)),
            host,
            move || {
                (name.as_str(), 0u16)
                    .to_socket_addrs()
                    .map(|addresses| addresses.map(|a| a.ip()).collect())
            },
        )
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

    #[tokio::test(start_paused = true)]
    async fn fifty_lookups_of_one_host_make_one_resolver_call() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let resolver = Resolver::new(ACTIVE, QUEUED);
        let lookups = Lookups::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let answers = futures_util::future::join_all((0..50).map(|_| {
            let calls = calls.clone();
            lookups.resolve(&resolver, "img.shields.io", move || {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(vec!["104.18.0.1".parse().unwrap()])
            })
        }))
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(answers.iter().all(|answer| answer.as_ref().unwrap().len() == 1));

        tokio::time::advance(ANSWER_TTL).await;
        let calls_again = calls.clone();
        lookups
            .resolve(&resolver, "img.shields.io", move || {
                calls_again.fetch_add(1, Ordering::SeqCst);
                Ok(vec![])
            })
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2, "an expired answer is asked for again");
    }

    #[tokio::test(start_paused = true)]
    async fn different_hosts_resolve_separately_and_a_failure_is_remembered_briefly() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let resolver = Resolver::new(ACTIVE, QUEUED);
        let lookups = Lookups::new();
        let calls = Arc::new(AtomicUsize::new(0));
        for host in ["a.example", "b.example"] {
            let calls = calls.clone();
            lookups
                .resolve(&resolver, host, move || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(vec![])
                })
                .await
                .unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        for _ in 0..3 {
            let calls = calls.clone();
            assert!(lookups
                .resolve(&resolver, "gone.example", move || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Err(std::io::Error::other("no such host"))
                })
                .await
                .is_err());
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3, "one failed attempt for the burst");
        tokio::time::advance(FAILURE_TTL).await;
        let calls_again = calls.clone();
        let _ = lookups
            .resolve(&resolver, "gone.example", move || {
                calls_again.fetch_add(1, Ordering::SeqCst);
                Ok(vec![])
            })
            .await;
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn expired_hosts_are_dropped_once_the_table_is_full() {
        let resolver = Resolver::new(ACTIVE, QUEUED);
        let lookups = Lookups::new();
        for i in 0..MAX_HOSTS {
            let _ = lookups
                .resolve(&resolver, &format!("h{i}.example"), || {
                    Err(std::io::Error::other("fixture"))
                })
                .await;
        }
        assert_eq!(lookups.hosts.lock().unwrap().len(), MAX_HOSTS);
        tokio::time::advance(FAILURE_TTL).await;
        let _ = lookups
            .resolve(&resolver, "new.example", || Ok(vec![]))
            .await;
        assert_eq!(lookups.hosts.lock().unwrap().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_full_table_of_fresh_hosts_drops_its_oldest_for_a_new_one() {
        let resolver = Resolver::new(ACTIVE, QUEUED);
        let lookups = Lookups::new();
        for i in 0..MAX_HOSTS {
            let _ = lookups
                .resolve(&resolver, &format!("h{i}.example"), || Ok(vec![]))
                .await;
            tokio::time::advance(Duration::from_millis(1)).await;
        }
        let _ = lookups.resolve(&resolver, "new.example", || Ok(vec![])).await;
        let hosts = lookups.hosts.lock().unwrap();
        assert_eq!(hosts.len(), MAX_HOSTS);
        assert!(!hosts.contains_key("h0.example"));
        assert!(hosts.contains_key("new.example") && hosts.contains_key("h1.example"));
    }
}
