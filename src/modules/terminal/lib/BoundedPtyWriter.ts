import type { PtySession } from "./pty-bridge";

/**
 * Input, and separately terminal replies, queued behind a PTY that is not
 * reading; more is refused.
 */
const MAX_PENDING_BYTES = 256 * 1024;
/**
 * The largest terminal reply taken past that budget: a Kitty clipboard
 * answer carries up to 32 MiB as base64 (`terminalIntegration.ts`).
 */
const MAX_REPLY_BYTES = 64 * 1024 * 1024;
const MAX_WRITE_BATCH_BYTES = 64 * 1024;
const MAX_PENDING_ACTIONS = 256;

type PendingBytes = { kind: "bytes"; bytes: Uint8Array; reply: boolean; valid?: () => boolean; cancelled?: () => void };
type PendingAction = { kind: "action"; run: (() => void) | null; active: boolean; size: number };
type Pending = PendingBytes | PendingAction;

/**
 * One session's input to its PTY, in order, one write in flight at a time,
 * small chunks batched.
 */
export class BoundedPtyWriter {
  private readonly queue: Pending[] = [];
  private pty: PtySession | null = null;
  private flushing = false;
  private disposed = false;
  private failed = false;
  private generation = 0;
  private inputBytes = 0;
  private replyBytes = 0;
  private actions = 0;
  private actionBytes = 0;
  private insertion: number | null = null;

  constructor(private readonly onError: (error: unknown) => void) {}

  attach(pty: PtySession): void {
    if (this.disposed) return;
    this.generation += 1;
    this.pty = pty;
    void this.flush();
  }

  detach(): void {
    this.generation += 1;
    this.pty = null;
    this.failed = false;
    this.clear();
  }

  /** Bytes queued and not yet handed to the PTY. */
  get pendingBytes(): number {
    return this.inputBytes + this.replyBytes + this.actionBytes;
  }

  get hasPendingInput(): boolean {
    return this.actions > 0 || this.queue.some((item) => item.kind === "bytes" && !item.reply);
  }

  get holdingInput(): boolean {
    return this.actions > 0;
  }

  clear(): void {
    for (const item of this.queue) if (item.kind === "action") item.active = false;
    this.queue.length = 0;
    this.inputBytes = 0;
    this.replyBytes = 0;
    this.actions = 0;
    this.actionBytes = 0;
  }

  private insert(item: Pending): void {
    if (this.insertion === null) this.queue.push(item);
    else this.queue.splice(this.insertion++, 0, item);
  }

  /** Reserve this position before beginning an asynchronous input operation. */
  reserveInput(): ((action: () => void, size?: number) => void) | null {
    if (this.disposed || this.failed) return null;
    if (this.actions >= MAX_PENDING_ACTIONS) {
      this.fail(new Error("Terminal input queue is full"));
      return null;
    }
    const item: PendingAction = { kind: "action", run: null, active: true, size: 0 };
    this.actions++;
    this.insert(item);
    return (action, size = 0) => {
      if (!item.active || item.run) return;
      if (!Number.isSafeInteger(size) || size < 0 ||
          this.inputBytes + this.actionBytes + size > MAX_PENDING_BYTES) {
        this.fail(new Error("Terminal input queue is full"));
        return;
      }
      item.size = size;
      this.actionBytes += size;
      item.run = action;
      void this.flush();
    };
  }

  /** Delay synchronous editor input only while a reserved operation is pending. */
  deferInput(action: () => void, size = 0): boolean {
    if (this.disposed || this.failed) return true;
    if (this.insertion !== null || this.actions === 0) return false;
    const resolve = this.reserveInput();
    if (resolve) resolve(action, size);
    return true;
  }

  /**
   * Queues `bytes`; false when refused. Terminal replies (`reply`) have a
   * budget of their own, so answers a program asked for never crowd out what
   * the user types; one may exceed it while no backlog beyond it is queued,
   * so a large answer goes through and a program that does not read its
   * input still cannot grow the queue without bound.
   */
  enqueue(bytes: Uint8Array, reply = false, valid?: () => boolean, cancelled?: () => void): boolean {
    if (this.disposed || this.failed || bytes.byteLength === 0) return false;
    const queued = reply ? this.replyBytes : this.inputBytes + this.actionBytes;
    const fits =
      queued + bytes.byteLength <= MAX_PENDING_BYTES ||
      (reply &&
        queued <= MAX_PENDING_BYTES &&
        bytes.byteLength <= MAX_REPLY_BYTES);
    if (!fits) {
      this.fail(new Error("Terminal input queue is full"));
      return false;
    }
    this.insert({ kind: "bytes", bytes, reply, valid, cancelled });
    if (reply) this.replyBytes += bytes.byteLength;
    else this.inputBytes += bytes.byteLength;
    void this.flush();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.pty = null;
    this.clear();
  }

  private fail(error: unknown): void {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.clear();
    this.onError(error);
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.disposed || this.failed || !this.pty) return;
    this.flushing = true;
    try {
      while (!this.disposed && !this.failed && this.pty && this.queue.length > 0) {
        const first = this.queue[0];
        if (first.kind === "action") {
          if (!first.run) return;
          this.queue.shift();
          first.active = false;
          this.actions--;
          this.actionBytes -= first.size;
          this.insertion = 0;
          try { first.run(); } catch (error) { this.fail(error); }
          finally { this.insertion = null; }
          continue;
        }
        let valid = true;
        try { if (first.valid) valid = first.valid(); }
        catch (error) { this.fail(error); return; }
        if (!valid) {
          this.queue.shift();
          if (first.reply) this.replyBytes -= first.bytes.byteLength;
          else this.inputBytes -= first.bytes.byteLength;
          try { first.cancelled?.(); } catch (error) { this.fail(error); return; }
          continue;
        }
        const pty = this.pty;
        const generation = this.generation;
        const batch = this.takeBatch();
        try {
          await pty.write(batch);
        } catch (error) {
          if (generation !== this.generation) continue;
          this.fail(error);
          return;
        }
      }
    } finally {
      this.flushing = false;
      if (!this.disposed && !this.failed && this.pty && this.queue.length > 0 &&
          (this.queue[0].kind !== "action" || this.queue[0].run)) {
        queueMicrotask(() => void this.flush());
      }
    }
  }

  private takeBatch(): Uint8Array {
    let length = 0;
    let count = 0;
    while (count < this.queue.length) {
      const next = this.queue[count];
      if (next.kind !== "bytes" || next.valid) break;
      const nextLength = next.bytes.byteLength;
      if (count > 0 && length + nextLength > MAX_WRITE_BATCH_BYTES) break;
      length += nextLength;
      count += 1;
      if (length >= MAX_WRITE_BATCH_BYTES) break;
    }

    if (count === 0) count = 1;
    const taken = this.queue.splice(0, count) as PendingBytes[];
    for (const { bytes, reply } of taken) {
      if (reply) this.replyBytes -= bytes.byteLength;
      else this.inputBytes -= bytes.byteLength;
    }
    if (taken.length === 1) return taken[0].bytes;
    const batch = new Uint8Array(length);
    let offset = 0;
    for (const { bytes } of taken) {
      batch.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return batch;
  }
}
