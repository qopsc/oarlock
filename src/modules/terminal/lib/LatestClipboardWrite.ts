/** Clipboard writes one at a time, a burst coalesced to its latest value. */
export class LatestClipboardWrite<T = string> {
  private pending: { readonly value: T; prepared: boolean } | null = null;
  private running = false;
  private scheduled = false;

  constructor(
    private readonly write: (value: T) => Promise<void>,
    private readonly prepare?: (value: T) => void,
    private readonly discard?: (value: T) => void,
  ) {}

  enqueue(value: T): void {
    if (this.pending) this.discard?.(this.pending.value);
    this.pending = { value, prepared: false };
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.pending && !this.pending.prepared) {
        this.prepare?.(this.pending.value);
        this.pending.prepared = true;
      }
      if (!this.running) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.pending?.prepared) {
        const { value } = this.pending;
        this.pending = null;
        try {
          await this.write(value);
        } catch {
          /* Later writes can still succeed. */
        }
      }
    } finally {
      this.running = false;
      if (this.pending) this.schedule();
    }
  }
}
