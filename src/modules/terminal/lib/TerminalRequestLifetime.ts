/** One terminal generation, with independently revocable clipboard reads. */
export class TerminalRequestLifetime {
  private readonly lifetime = new AbortController();
  private reads = new AbortController();
  private writes: AbortController | null = null;
  private disposed = false;

  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  get clipboardSignal(): AbortSignal {
    return this.reads.signal;
  }

  get programSignal(): AbortSignal {
    if (this.disposed) return this.signal;
    this.writes ??= new AbortController();
    return this.writes.signal;
  }

  cancelReads(): void {
    this.reads.abort();
    if (!this.signal.aborted) this.reads = new AbortController();
  }

  endInput(): void {
    this.lifetime.abort();
    this.reads.abort();
  }

  dispose(): void {
    this.disposed = true;
    this.endInput();
    this.writes?.abort();
  }
}
