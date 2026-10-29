//! One deadline for all phases of a bounded network operation.
use std::{future::Future, time::Duration};
use tokio::time::{sleep_until, Instant};

pub async fn within<T>(
    budget: Duration,
    label: &str,
    operation: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let deadline = Instant::now() + budget;
    let expired = || format!("{label} timed out after {} seconds", budget.as_secs_f64());
    tokio::select! {
        biased;
        _ = sleep_until(deadline) => Err(expired()),
        result = operation => {
            // Do not accept completion from a poll that ran past the deadline.
            if Instant::now() >= deadline { Err(expired()) } else { result }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn all_phases_share_a_deadline_and_expiry_drops_owned_work() {
        let (alive, mut closed) = tokio::sync::oneshot::channel::<()>();
        let result = within(Duration::from_secs(5), "Probe", async move {
            let _alive = alive;
            tokio::time::sleep(Duration::from_secs(3)).await;
            tokio::time::sleep(Duration::from_secs(3)).await;
            Ok(())
        })
        .await;
        assert_eq!(result.unwrap_err(), "Probe timed out after 5 seconds");
        assert!(matches!(
            closed.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Closed)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn an_expired_operation_is_never_polled() {
        let result = within(Duration::ZERO, "Probe", async {
            panic!("expired work must not start");
            #[allow(unreachable_code)]
            Ok(())
        })
        .await;
        assert!(result.unwrap_err().contains("timed out"));
    }

    #[tokio::test(start_paused = true)]
    async fn ordinary_results_and_errors_are_preserved() {
        assert_eq!(
            within(Duration::from_secs(5), "Probe", async { Ok(7) }).await,
            Ok(7)
        );
        assert_eq!(
            within(Duration::from_secs(5), "Probe", async {
                Err::<(), _>("refused".into())
            })
            .await,
            Err("refused".into())
        );
    }
}
