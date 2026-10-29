import { invoke, isTauri } from "@tauri-apps/api/core";
import { networkPage } from "./networkPage";

let sequence = 0;
type Ticket = { pageGeneration: string; ticket: string };

/** Reservation order precedes preparation (including lazy imports/conversion). */
export class ClipboardWrite {
  private readonly sequence = ++sequence;
  private ready: Promise<Ticket | null> | null = null;
  private ticket: Ticket | null = null;
  private disposed = false;
  private committed = false;
  private readonly controller = new AbortController();
  private readonly abort = () => this.dispose();

  constructor(
    private readonly primary = false,
    private readonly owner?: AbortSignal,
  ) {
    owner?.addEventListener("abort", this.abort, { once: true });
    if (owner?.aborted) this.dispose();
  }

  prepare(): void {
    if (this.ready || this.disposed) return;
    this.ready = this.reserve();
    // Prepared pending writes can be superseded before their consumer awaits.
    void this.ready.catch(() => {});
  }

  private async reserve(): Promise<Ticket | null> {
    if (!isTauri()) return null;
    const pageGeneration = await networkPage(this.controller.signal);
    this.controller.signal.throwIfAborted();
    const ticket = await invoke<string>("clipboard_write_begin", {
      pageGeneration,
      sequence: this.sequence,
      primary: this.primary,
    });
    this.ticket = { pageGeneration, ticket };
    if (this.disposed) this.cancel();
    this.controller.signal.throwIfAborted();
    return this.ticket;
  }

  private async admission(): Promise<Ticket | null> {
    this.controller.signal.throwIfAborted();
    this.prepare();
    const ticket = await this.ready;
    this.controller.signal.throwIfAborted();
    return ticket;
  }

  async text(text: string): Promise<void> {
    const ticket = await this.admission();
    if (ticket)
      await invoke("clipboard_text_write", {
        ...ticket,
        text,
        primary: this.primary,
      });
    else if (!this.primary) {
      if (!navigator.clipboard) throw new Error("Clipboard is unavailable");
      await navigator.clipboard.writeText(text);
    }
    this.committed = true;
  }

  async image(png: Uint8Array): Promise<void> {
    const ticket = await this.admission();
    if (!ticket) throw new Error("Clipboard images need the app");
    await invoke("clipboard_image_write", png, {
      headers: {
        "x-page-generation": ticket.pageGeneration,
        "x-clipboard-ticket": ticket.ticket,
      },
    });
    this.committed = true;
  }

  /** Wait for ownership before expensive conversion; reservation may fail stale. */
  async check(): Promise<void> {
    await this.admission();
  }

  private cancel(): void {
    if (this.ticket && !this.committed) {
      void invoke("clipboard_write_cancel", this.ticket).catch(() => {});
      this.ticket = null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.owner?.removeEventListener("abort", this.abort);
    this.controller.abort();
    this.cancel();
  }
}

export async function writeClipboardText(text: string): Promise<void> {
  const write = new ClipboardWrite();
  write.prepare();
  try {
    await write.text(text);
  } finally {
    write.dispose();
  }
}

/** Browser/menu copy and cut keep their native formats. Announce their intent
 * so older Oarlock preparation cannot commit later. OS writes already started
 * and clipboard changes from other applications cannot be rolled back. */
export function installClipboardCopyBarrier(): void {
  const copy = () => {
    if (!isTauri()) return;
    const write = new ClipboardWrite();
    write.prepare();
    void write
      .check()
      .catch(() => {})
      .finally(() => write.dispose());
  };
  document.addEventListener("copy", copy, true);
  document.addEventListener("cut", copy, true);
}
