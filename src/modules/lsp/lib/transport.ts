import { networkPage } from "@/lib/networkPage";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { Transport } from "codemirror-languageserver";
import { lspShell } from "./detect";
import { OrderedLspWriter } from "./orderedWriter";

export type LspSpawnConfig = {
  presetId?: string;
  generation?: number;
  command: string;
  args: string[];
  root: string;
  env?: Record<string, string>;
  maxMemoryMb?: number;
};

export type LspExitInfo = {
  code: number | null;
  stderrTail: string;
  reason: string | null;
};

type ServerRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};

function isServerRequest(msg: unknown): msg is ServerRequest {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "id" in msg &&
    (msg as ServerRequest).id != null &&
    "method" in msg
  );
}

export class TauriLspTransport implements Transport {
  private pageGeneration: string | null = null;
  private readonly startup = new AbortController();
  private sessionId: number | null = null;
  private closed = false;
  private onMsg: ((message: string) => void) | null = null;
  private onCloseCb: (() => void) | null = null;
  private onErrorCb: ((error: Error) => void) | null = null;
  private backlog: string[] = [];
  private writer: OrderedLspWriter | null = null;
  exitInfo: LspExitInfo | null = null;

  async start(config: LspSpawnConfig): Promise<void> {
    this.pageGeneration = await networkPage(this.startup.signal);
    if (this.closed) throw new Error("lsp: startup cancelled");
    const decoder = new TextDecoder();
    const onMessage = new Channel<ArrayBuffer>();
    onMessage.onmessage = (buf) => {
      if (this.closed) return;
      const text = decoder.decode(buf);
      this.receive(text);
    };
    const onExit = new Channel<LspExitInfo>();
    onExit.onmessage = (info) => {
      if (this.closed) return;
      this.writer?.close();
      this.exitInfo = info;
      this.closed = true;
      this.backlog = [];
      this.onMsg = null;
      this.onCloseCb?.();
    };
    const id = await invoke<number>("lsp_spawn", {
      pageGeneration: this.pageGeneration,
      presetId: config.presetId ?? config.command,
      generation: config.generation ?? 0,
      command: config.command,
      args: config.args,
      env: config.env ?? null,
      root: config.root,
      maxRssMb: config.maxMemoryMb ?? null,
      workspace: { kind: "local" },
      shell: lspShell(),
      onMessage,
      onExit,
    });
    if (this.closed) {
      await invoke("lsp_kill", {
        id,
        pageGeneration: this.pageGeneration,
      }).catch(() => {});
      return;
    }
    this.sessionId = id;
    const queued = this.backlog;
    this.backlog = [];
    for (const text of queued) this.receive(text);
  }

  private receive(text: string): void {
    if (this.closed) return;
    // Channel traffic can beat the spawn reply that supplies the send ID.
    if (this.sessionId == null) {
      this.backlog.push(text);
      return;
    }
    if (this.answerServerRequest(text)) return;
    if (this.onMsg) this.onMsg(text);
    else this.backlog.push(text);
  }

  // Consume handled requests: the library otherwise adds a second null reply.
  private answerServerRequest(text: string): boolean {
    // Cheap pre-check: requests carry both markers; skips a redundant
    // JSON.parse of large notification payloads like publishDiagnostics.
    if (!text.includes('"id"') || !text.includes('"method"')) return false;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return false;
    }
    if (!isServerRequest(msg)) return false;
    const reply = (body: Record<string, unknown>) =>
      this.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }));
    switch (msg.method) {
      case "workspace/configuration": {
        const items =
          (msg.params as { items?: unknown[] } | undefined)?.items ?? [];
        if (!Array.isArray(items)) {
          reply({
            error: { code: -32602, message: "Invalid configuration items" },
          });
          return true;
        }
        reply({ result: items.map(() => null) });
        return true;
      }
      case "window/workDoneProgress/create":
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/showMessageRequest":
      case "workspace/workspaceFolders":
        reply({ result: null });
        return true;
      default:
        reply({
          error: { code: -32601, message: `unhandled method ${msg.method}` },
        });
        return true;
    }
  }

  send(message: string): void {
    if (this.sessionId == null || this.closed) return;
    this.writer ??= new OrderedLspWriter(
      (message) =>
        invoke("lsp_send", {
          id: this.sessionId,
          message,
          pageGeneration: this.pageGeneration,
        }),
      (reason) => {
        if (this.closed) return;
        this.exitInfo = { code: null, stderrTail: "", reason };
        this.close();
        try {
          this.onErrorCb?.(new Error(reason));
        } finally {
          this.onCloseCb?.();
        }
      },
    );
    this.writer.send(message);
  }

  onMessage(callback: (message: string) => void): void {
    if (this.closed) return;
    this.onMsg = callback;
    if (this.backlog.length > 0) {
      const queued = this.backlog;
      this.backlog = [];
      for (const m of queued) {
        if (this.closed) break;
        callback(m);
      }
    }
  }

  onClose(callback: () => void): void {
    this.onCloseCb = callback;
    if (this.closed) callback();
  }

  onError(callback: (error: Error) => void): void {
    this.onErrorCb = callback;
  }

  close(): void {
    this.writer?.close();
    this.startup.abort();
    this.backlog = [];
    this.onMsg = null;
    if (this.closed) {
      this.sessionId = null;
      return;
    }
    this.closed = true;
    if (this.sessionId != null) {
      void invoke("lsp_kill", {
        id: this.sessionId,
        pageGeneration: this.pageGeneration,
      }).catch(() => {});
      this.sessionId = null;
    }
  }
}

export async function retireLspGeneration(
  presetId: string,
  generation: number,
): Promise<void> {
  const pageGeneration = await networkPage(new AbortController().signal);
  await invoke("lsp_retire_generation", {
    pageGeneration,
    presetId,
    generation,
  });
}
