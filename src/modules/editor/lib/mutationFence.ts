/** The highest mutation-stream sequence this window's listener has handled. An
 * editor read carries the stream sequence sampled after its bytes were read, so a
 * read that saw what an announced Git Discard wrote is judged only after the
 * announcement (`discard-begin`) has been handled. No timer: the wait ends with
 * the next event, or when the listener goes down. */
type Waiter = { sequence: number; release: () => void };

let handled = 0;
let live = false;
let waiters: Waiter[] = [];

function releaseReached(): void {
  const ready = waiters.filter((waiter) => waiter.sequence <= handled);
  if (ready.length === 0) return;
  waiters = waiters.filter((waiter) => waiter.sequence > handled);
  for (const waiter of ready) waiter.release();
}

export function mutationFenceAdvance(sequence: number): void {
  if (sequence > handled) handled = sequence;
  releaseReached();
}

/** The listener is installed and `sequence` is the stream's current position. */
export function mutationFenceLive(sequence: number): void {
  live = true;
  mutationFenceAdvance(sequence);
}

/** The listener is gone (disposed, failed or not yet installed): nothing waits. */
export function mutationFenceDown(): void {
  live = false;
  const all = waiters;
  waiters = [];
  for (const waiter of all) waiter.release();
}

/** Null when the read can be judged now. */
export function awaitMutationSequence(
  sequence: number | undefined,
): Promise<void> | null {
  if (sequence === undefined || !live || sequence <= handled) return null;
  return new Promise((release) => {
    waiters.push({ sequence, release });
  });
}
