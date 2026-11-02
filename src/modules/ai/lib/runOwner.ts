import { invoke } from "@tauri-apps/api/core";

/** `prepare`: composer work before a message is sent. `turn`: an agent run.
 *  `work`: a tool or sub-agent that Stop must wait for. */
export type RunKind = "prepare" | "turn" | "work";
export type RunPhase =
  "preparing" | "accepted" | "running" | "paused" | "closing" | "closed";
export type CloseReason =
  | "complete"
  | "error"
  | "abort"
  | "cancel"
  | "stop"
  | "deleted"
  | "navigated"
  | "abandoned"
  | "continued";

export interface RunOwner {
  readonly runId: string;
  readonly chatId: string | null;
  readonly kind: RunKind;
  readonly phase: RunPhase;
  readonly signal: AbortSignal;
  /** Settles when the native record exists and the chat may start a turn. */
  readonly ready: Promise<void>;
  adopt(label: string, release: () => Promise<void>): void;
  /** Runs once when preparation ends: accepted, cancelled or closed. */
  onPrepared(cleanup: () => void): void;
  cancel(reason: CloseReason): void;
  accept(userMessageId?: string): void;
  wrapStream<T>(
    source: ReadableStream<T>,
    options?: { signal?: AbortSignal; observe?: (chunk: T) => void },
  ): ReadableStream<T>;
  pause(): void;
  /** The turn's setup is over (a stream exists or the run failed). */
  setupDone(): void;
  /** Ends preparation that never reached a turn; a running turn is untouched. */
  abandon(): void;
  close(reason: CloseReason): Promise<void>;
}

type Release = { label: string; release: () => Promise<void>; done: boolean };

const registry = new Map<string, Set<Owner>>();
const paused = new Map<string, Owner>();
const stoppedMessages = new Map<string, string[]>();

function newRunId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

class Owner implements RunOwner {
  readonly runId = newRunId();
  phase: RunPhase = "preparing";
  ready: Promise<void> = Promise.resolve();
  userMessageId: string | undefined;
  quiescent = false;
  private readonly controller = new AbortController();
  private readonly releases: Release[] = [];
  private prepared: (() => void)[] = [];
  private preparedDone: boolean;
  private closing: Promise<void> | undefined;
  private resolveQuiesced!: () => void;
  readonly quiesced = new Promise<void>((resolve) => {
    this.resolveQuiesced = resolve;
  });

  constructor(
    readonly chatId: string | null,
    public kind: RunKind,
  ) {
    this.preparedDone = kind !== "prepare";
    this.phase = kind === "prepare" ? "preparing" : "running";
    if (chatId) {
      const owners = registry.get(chatId) ?? new Set();
      owners.add(this);
      registry.set(chatId, owners);
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  adopt(label: string, release: () => Promise<void>) {
    if (this.phase === "closing" || this.phase === "closed") {
      void release().catch((error) =>
        console.warn(`Run cleanup failed (${label})`, error),
      );
      return;
    }
    this.releases.push({ label, release, done: false });
  }

  onPrepared(cleanup: () => void) {
    if (this.preparedDone) cleanup();
    else this.prepared.push(cleanup);
  }

  private runPrepared() {
    if (this.preparedDone) return;
    this.preparedDone = true;
    const cleanups = this.prepared;
    this.prepared = [];
    for (const cleanup of cleanups) cleanup();
  }

  cancel(reason: CloseReason) {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
    if (this.kind === "prepare" && this.phase === "preparing")
      void this.close(reason).catch(() => {});
  }

  accept(userMessageId?: string) {
    if (this.phase !== "preparing") return;
    this.userMessageId = userMessageId;
    this.phase = "accepted";
    this.runPrepared();
  }

  claim() {
    this.kind = "turn";
    this.phase = "running";
  }

  pause() {
    if (this.phase !== "running" || !this.chatId) return;
    this.phase = "paused";
    const other = paused.get(this.chatId);
    if (other && other !== this) void other.close("continued").catch(() => {});
    paused.set(this.chatId, this);
    this.setupDone();
  }

  abandon() {
    if (this.phase === "preparing" || this.phase === "accepted")
      void this.close("abandoned").catch(() => {});
  }

  setupDone() {
    this.quiescent = true;
    this.resolveQuiesced();
  }

  wrapStream<T>(
    source: ReadableStream<T>,
    options: { signal?: AbortSignal; observe?: (chunk: T) => void } = {},
  ): ReadableStream<T> {
    const reader = source.getReader();
    const approvals = new Set<string>();
    let failed = false;
    let ended = false;
    const finish = (reason: CloseReason) => {
      options.signal?.removeEventListener("abort", aborted);
      this.controller.signal.removeEventListener("abort", aborted);
      return this.close(reason);
    };
    const aborted = () => {
      void finish("abort").catch((error) =>
        console.warn("Run cleanup failed", error),
      );
    };
    this.adopt("stream", async () => {
      if (!ended) await reader.cancel("run closed").catch(() => {});
    });
    options.signal?.addEventListener("abort", aborted, { once: true });
    this.controller.signal.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted || this.controller.signal.aborted) aborted();
    const complete = async () => {
      ended = true;
      const pending = approvals.size > 0;
      if (
        pending &&
        !failed &&
        !options.signal?.aborted &&
        !this.controller.signal.aborted
      ) {
        options.signal?.removeEventListener("abort", aborted);
        this.controller.signal.removeEventListener("abort", aborted);
        this.pause();
      } else await finish("complete");
    };
    return new ReadableStream<T>({
      pull: async (controller) => {
        try {
          const next = await reader.read();
          if (next.done) {
            await complete();
            controller.close();
          } else {
            const chunk = next.value as { type?: string; toolCallId?: string };
            if (chunk.type === "tool-approval-request" && chunk.toolCallId)
              approvals.add(chunk.toolCallId);
            else if (
              (chunk.type === "tool-output-available" ||
                chunk.type === "tool-output-error" ||
                chunk.type === "tool-output-denied") &&
              chunk.toolCallId
            )
              approvals.delete(chunk.toolCallId);
            else if (chunk.type === "error" || chunk.type === "abort")
              failed = true;
            options.observe?.(next.value);
            controller.enqueue(next.value);
          }
        } catch (error) {
          ended = true;
          await finish("error").catch(() => {});
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        try {
          ended = true;
          await reader.cancel(reason);
        } finally {
          await finish("cancel");
        }
      },
    });
  }

  close(reason: CloseReason): Promise<void> {
    if (this.closing) return this.closing;
    if (this.phase === "accepted" && this.chatId && this.userMessageId) {
      const stopped = stoppedMessages.get(this.chatId) ?? [];
      stopped.push(this.userMessageId);
      stoppedMessages.set(this.chatId, stopped.slice(-8));
    }
    this.phase = "closing";
    this.runPrepared();
    if (this.chatId && paused.get(this.chatId) === this)
      paused.delete(this.chatId);
    if (reason !== "complete" && !this.controller.signal.aborted)
      this.controller.abort(reason);
    const run = async () => {
      for (let i = this.releases.length - 1; i >= 0; i--) {
        const entry = this.releases[i];
        if (entry.done) continue;
        await entry.release();
        entry.done = true;
      }
    };
    this.closing = run().then(
      () => {
        this.phase = "closed";
        this.forget();
        this.setupDone();
      },
      (error) => {
        this.closing = undefined;
        throw error;
      },
    );
    return this.closing;
  }

  private forget() {
    if (!this.chatId) return;
    const owners = registry.get(this.chatId);
    owners?.delete(this);
    if (owners?.size === 0) registry.delete(this.chatId);
  }
}

export function beginRun(
  chatId: string | null,
  options: {
    kind: RunKind;
    /** Registers the run with native and admits it past the Stop barrier. */
    admit?: (runId: string) => Promise<void>;
  },
): RunOwner {
  const owner = new Owner(chatId, options.kind);
  if (options.admit && chatId) {
    owner.adopt("native run", () =>
      invoke<void>("ai_run_end", { runId: owner.runId }),
    );
    owner.ready = options.admit(owner.runId);
    void owner.ready.catch(() => {});
  }
  return owner;
}

/** The accepted owner of the user message a request answers. */
export function claimRun(
  chatId: string,
  messages: readonly { id: string; role: string }[],
): RunOwner | undefined {
  const userId = [...messages].reverse().find((m) => m.role === "user")?.id;
  if (!userId) return undefined;
  if (stoppedMessages.get(chatId)?.includes(userId))
    throw new Error("This message was stopped before it started.");
  for (const owner of registry.get(chatId) ?? []) {
    if (owner.phase === "accepted" && owner.userMessageId === userId) {
      owner.claim();
      return owner;
    }
  }
  return undefined;
}

export function takePaused(chatId: string | null): RunOwner | undefined {
  if (!chatId) return undefined;
  const owner = paused.get(chatId);
  paused.delete(chatId);
  return owner;
}

/** A tool or sub-agent Stop has to wait for; the returned function ends it. */
export function trackWork(chatId: string | null): () => void {
  if (!chatId) return () => {};
  const owner = beginRun(chatId, { kind: "work" });
  return () => void owner.close("complete");
}

export function chatHasRuns(chatId: string): boolean {
  for (const owner of registry.get(chatId) ?? [])
    if (owner.kind === "turn" || owner.phase === "accepted") return true;
  return false;
}

/** Synchronous: composer work that has not handed a message to the chat yet. */
export function cancelPreparation(chatId: string) {
  for (const owner of [...(registry.get(chatId) ?? [])])
    if (owner.kind === "prepare" && owner.phase === "preparing")
      owner.cancel("stop");
}

/** Stop and delete: abort every owner of the chat, wait for tools and turn
 *  setup, then release everything. A release that fails stays reachable. */
export async function closeChatRuns(
  chatId: string,
  reason: CloseReason,
): Promise<void> {
  const owners = () => [...(registry.get(chatId) ?? [])];
  for (const owner of owners()) if (owner.kind !== "work") owner.cancel(reason);
  for (;;) {
    const pending = owners().filter(
      (owner) =>
        (owner.kind === "work" || owner.kind === "turn") && !owner.quiescent,
    );
    if (!pending.length) break;
    await Promise.all(pending.map((owner) => owner.quiesced));
  }
  const results = await Promise.allSettled(
    owners()
      .filter((owner) => owner.kind !== "work")
      .map((owner) => owner.close(reason)),
  );
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw (failed as PromiseRejectedResult).reason;
  paused.delete(chatId);
}
