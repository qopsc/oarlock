export const LSP_WRITE_MESSAGES = 256;
export const LSP_WRITE_BYTES = 16 * 1024 * 1024;
export const LSP_WRITE_TIMEOUT_MS = 30_000;

/** UTF-8 wire size without allocating another copy of the document. */
export function utf8Size(text: string, limit = LSP_WRITE_BYTES): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes++;
    else if (c < 0x800) bytes += 2;
    else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
    if (bytes > limit) break;
  }
  return bytes;
}

type Entry = { message: string; bytes: number };

/** One acknowledged write at a time. Budgets include the in-flight message. */
export class OrderedLspWriter {
  private queue: Entry[] = [];
  private active: Entry | null = null;
  private bytes = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly write: (message: string) => Promise<unknown>,
    private readonly failed: (reason: string) => void,
  ) {}

  send(message: string): void {
    if (this.closed) return;
    const count = this.queue.length + (this.active ? 1 : 0);
    const remaining = LSP_WRITE_BYTES - this.bytes;
    const bytes =
      message.length > remaining ? remaining + 1 : utf8Size(message, remaining);
    if (count >= LSP_WRITE_MESSAGES || bytes > remaining) {
      this.fail(
        "Language server write queue exceeded 256 messages or 16 MiB. Restart the language server to synchronize the document again.",
      );
      return;
    }
    this.queue.push({ message, bytes });
    this.bytes += bytes;
    this.pump();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) this.active.message = "";
    this.active = null;
    this.queue = [];
    this.bytes = 0;
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.close();
    this.failed(reason);
  }

  private pump(): void {
    if (this.closed || this.active || !this.queue.length) return;
    const entry = this.queue.shift() as Entry;
    this.active = entry;
    this.timer = setTimeout(
      () =>
        this.fail(
          "Language server write stalled for 30 seconds. Restart the language server to synchronize the document again.",
        ),
      LSP_WRITE_TIMEOUT_MS,
    );
    let writing: Promise<unknown>;
    try {
      writing = this.write(entry.message);
    } catch (error) {
      this.fail(`Language server write failed: ${String(error)}`);
      return;
    }
    void writing.then(
      () => {
        if (this.closed || this.active !== entry) return;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.bytes -= entry.bytes;
        this.active = null;
        this.pump();
      },
      (error) => this.fail(`Language server write failed: ${String(error)}`),
    );
  }
}
