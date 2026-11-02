//! App-wide admission for clipboard captures and image conversion.
use std::sync::{Arc, OnceLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const SNAPSHOT_LIMIT: usize = 4;
const IMAGE_LIMIT: usize = 1;
const BUSY: &str = "Clipboard is busy. Try again.";

pub(super) struct ClipboardWork {
    snapshots: Arc<Semaphore>,
    images: Arc<Semaphore>,
}

pub(super) struct SnapshotPermit {
    _snapshot: OwnedSemaphorePermit,
    image: Option<OwnedSemaphorePermit>,
    images: Arc<Semaphore>,
}

impl SnapshotPermit {
    pub(super) fn require_image(&mut self) -> Result<(), String> {
        if self.image.is_none() {
            self.image = Some(self.images.clone().try_acquire_owned().map_err(|_| BUSY)?);
        }
        Ok(())
    }
}

impl ClipboardWork {
    fn new(snapshots: usize, images: usize) -> Self {
        Self {
            snapshots: Arc::new(Semaphore::new(snapshots)),
            images: Arc::new(Semaphore::new(images)),
        }
    }

    pub(super) fn snapshot(&self, image: bool) -> Result<SnapshotPermit, String> {
        let snapshot = self.snapshots.clone().try_acquire_owned().map_err(|_| BUSY)?;
        let mut permit = SnapshotPermit { _snapshot: snapshot, image: None, images: self.images.clone() };
        if image { permit.require_image()?; }
        Ok(permit)
    }

    pub(super) fn image(&self) -> Result<OwnedSemaphorePermit, String> {
        self.images.clone().try_acquire_owned().map_err(|_| BUSY.into())
    }
}

pub(super) fn budget() -> &'static ClipboardWork {
    static WORK: OnceLock<ClipboardWork> = OnceLock::new();
    WORK.get_or_init(|| ClipboardWork::new(SNAPSHOT_LIMIT, IMAGE_LIMIT))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn captures_and_image_work_share_bounded_permits() {
        let work = ClipboardWork::new(2, 1);
        let image = work.snapshot(true).unwrap();
        let text = work.snapshot(false).unwrap();
        assert!(work.snapshot(false).is_err());
        assert!(work.image().is_err());
        drop(image);
        let write = work.image().unwrap();
        assert!(work.snapshot(true).is_err());
        drop(write);
        drop(text);
        assert!(work.snapshot(true).is_ok());
    }

    #[tokio::test]
    async fn timed_out_caller_does_not_release_a_running_workers_permit() {
        let work = ClipboardWork::new(1, 1);
        let permit = work.snapshot(true).unwrap();
        let (release, wait) = std::sync::mpsc::channel();
        let worker = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let _ = wait.recv();
        });
        assert!(tokio::time::timeout(Duration::from_millis(20), worker).await.is_err());
        assert!(work.snapshot(true).is_err());
        release.send(()).unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if work.snapshot(true).is_ok() { break; }
            assert!(tokio::time::Instant::now() < deadline);
            tokio::task::yield_now().await;
        }
    }
}
