/** A view owns one latest history lookup and its debounce timer. */
export class HistorySearch {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private alive = true;
  private waiting = false;

  constructor(private readonly fetch: (query: string, limit: number) => Promise<string[]>) {}

  pending(): boolean { return this.waiting; }

  start(query: string, limit: number, delay: number, apply: (items: string[]) => void): void {
    this.cancel();
    if (!this.alive) return;
    const generation = this.generation;
    this.waiting = true;
    const run = () => {
      this.timer = undefined;
      void Promise.resolve().then(() => this.fetch(query, limit)).then(
        (items) => {
          if (!this.alive || generation !== this.generation) return;
          this.waiting = false;
          try { apply(items); }
          catch (error) { console.warn("History results could not be shown", error); }
        },
        (error) => {
          if (!this.alive || generation !== this.generation) return;
          this.waiting = false;
          console.warn("History search failed", error);
        },
      );
    };
    if (delay) this.timer = setTimeout(run, delay);
    else run();
  }

  cancel(): void {
    this.generation += 1;
    this.waiting = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void { this.alive = false; this.cancel(); }
}
