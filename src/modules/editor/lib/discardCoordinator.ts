import type { WorkspaceEnv } from "@/modules/workspace/env";
import type { DiscardPreparation } from "./documentSession";

export type DiscardScope = { paths: string[]; workspace: WorkspaceEnv };
export type DiscardEvent = DiscardScope & {
  id: string;
  token: string;
  nonce: string;
  owner: boolean;
  phase: "prepare" | "complete" | "cancel";
};
type Status = {
  phase: "preparing" | "running" | "finished" | "gone";
  ok: boolean;
};
type Request = {
  repoRoot: string;
  entries: { path: string; untracked: boolean }[];
  workspace: WorkspaceEnv;
};
type Preparation = DiscardPreparation & {
  ready?: (id: string, token: string) => Promise<void>;
};
type Io = {
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
  prepare: (scope: DiscardScope, preserve: boolean) => Preparation;
  problem: (error: unknown) => void;
};

/** One page's participation. No timer exists without an unfinished operation.
 * Native state, rather than transport success, decides when buffers may reload. */
export class DiscardCoordinator {
  private token: string | undefined;
  private alive = true;
  private queued: DiscardEvent[] = [];
  private origins = new Map<string, Preparation>();
  private rounds = new Map<string, Preparation>();
  private settled = new Set<string>();
  private finishing = new Set<string>();
  private preparing = new Map<string, Promise<void>>();
  private acknowledgements = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  constructor(private io: Io) {}

  ready(token: string): void {
    if (!this.alive) {
      void this.io
        .invoke("git_discard_unregister", { token })
        .catch(this.io.problem);
      return;
    }
    this.token = token;
    for (const event of this.queued.splice(0)) this.receive(event);
  }

  receive = (event: DiscardEvent): void => {
    if (!this.alive) return;
    if (!this.token) {
      this.queued.push(event);
      return;
    }
    if (event.token !== this.token) return;
    if (this.settled.has(event.id)) {
      this.acknowledge(event.id);
      return;
    }
    if (!this.rounds.has(event.id)) {
      const origin = event.owner ? this.origins.get(event.nonce) : undefined;
      this.rounds.set(event.id, origin ?? this.io.prepare(event, true));
    }
    if (event.phase === "prepare") {
      void this.prepare(event.id).catch(this.io.problem);
      this.arm();
    } else this.finish(event.id, event.phase === "complete");
  };

  async execute(request: Request): Promise<void> {
    if (!this.alive || !this.token)
      throw new Error(
        "Editor synchronization is not ready. Retry Discard after synchronization recovers.",
      );
    if (this.origins.size || this.rounds.size)
      throw new Error("Another Discard is still being synchronized.");
    const nonce = crypto.randomUUID();
    // Capture before any IPC or path authorization wait, at confirmation.
    const preparation = this.io.prepare(
      {
        paths: request.entries.map(
          ({ path }) => `${request.repoRoot.replace(/[\\/]+$/, "")}/${path}`,
        ),
        workspace: request.workspace,
      },
      false,
    );
    this.origins.set(nonce, preparation);
    let id: string | undefined;
    try {
      id = await this.io.invoke<string>("git_discard_begin", {
        ...request,
        token: this.token,
        nonce,
      });
      if (!this.alive) {
        await this.command("git_discard_cancel", id);
        throw new Error("Editor window closed before Discard started");
      }
      // Recover a missing prepare event, retaining the original revision.
      if (!this.rounds.has(id) && !this.settled.has(id))
        this.rounds.set(id, preparation);
      await this.prepare(id);
      this.arm();
      await this.command("git_discard", id);
      this.finish(id, true);
    } catch (error) {
      if (id) {
        // A rejected IPC does not prove the worker stopped. Keep protection if
        // native says running (or is unreachable), and reconcile in the poll.
        try {
          this.status(id, await this.command<Status>("git_discard_cancel", id));
        } catch (problem) {
          this.io.problem(problem);
        }
        this.arm();
      } else preparation.dispose(); // begin never dispatches Git
      throw error;
    } finally {
      this.origins.delete(nonce);
    }
  }

  private command<T>(command: string, id: string, args = {}): Promise<T> {
    return this.io.invoke<T>(command, { token: this.token, id, ...args });
  }
  private status(id: string, status: Status): void {
    if (!this.alive) return;
    if (status.phase === "finished" || status.phase === "gone")
      this.finish(id, status.ok);
    else if (status.phase === "preparing")
      void this.prepare(id).catch(this.io.problem);
  }
  private prepare(id: string): Promise<void> {
    const existing = this.preparing.get(id);
    if (existing) return existing;
    const preparation = this.rounds.get(id);
    if (!preparation || !this.token) return Promise.resolve();
    const task = (async () => {
      try {
        await preparation.ready?.(id, this.token as string);
        if (
          this.alive &&
          this.rounds.get(id) === preparation &&
          !this.finishing.has(id)
        )
          await this.command("git_discard_prepared", id, { ok: true });
      } catch (error) {
        if (this.alive)
          await this.command("git_discard_prepared", id, { ok: false });
        throw error;
      }
    })().finally(() => this.preparing.delete(id));
    this.preparing.set(id, task);
    return task;
  }
  private finish(id: string, ok: boolean): void {
    if (!this.alive || this.settled.has(id) || this.finishing.has(id)) return;
    const preparation = this.rounds.get(id);
    if (!preparation) return;
    this.finishing.add(id);
    const apply = (success: boolean) => {
      if (!this.alive || this.rounds.get(id) !== preparation) return;
      if (success) preparation.complete();
      else preparation.dispose();
      this.rounds.delete(id);
      this.finishing.delete(id);
      this.settled.add(id);
      if (this.settled.size > 32) {
        const oldest = this.settled.values().next().value;
        if (oldest !== undefined) this.settled.delete(oldest);
      }
      this.acknowledge(id);
    };
    if (preparation.ready && this.token) {
      void preparation.ready(id, this.token).then(
        () => apply(ok),
        (error: unknown) => {
          this.io.problem(error);
          apply(false);
        },
      );
    } else apply(ok);
  }
  private acknowledge(id: string): void {
    this.acknowledgements.add(id);
    void this.command("git_discard_settled", id)
      .then(() => {
        this.acknowledgements.delete(id);
      }, this.io.problem)
      .finally(() => this.arm());
  }
  private arm(): void {
    if (
      !this.alive ||
      this.timer ||
      this.polling ||
      (!this.rounds.size && !this.acknowledgements.size)
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reconcile();
    }, 2000);
  }
  async reconcile(): Promise<void> {
    if (!this.alive || this.polling) return;
    this.polling = true;
    try {
      await Promise.all(
        [...this.rounds.keys()].map(async (id) => {
          try {
            this.status(
              id,
              await this.command<Status>("git_discard_status", id),
            );
          } catch (error) {
            this.io.problem(error);
          }
        }),
      );
      for (const id of this.acknowledgements) this.acknowledge(id);
    } finally {
      this.polling = false;
      this.arm();
    }
  }
  dispose(): void {
    this.alive = false;
    clearTimeout(this.timer);
    this.queued = [];
    for (const preparation of new Set([
      ...this.rounds.values(),
      ...this.origins.values(),
    ]))
      preparation.dispose();
    this.rounds.clear();
    this.origins.clear();
    this.acknowledgements.clear();
    if (this.token)
      void this.io
        .invoke("git_discard_unregister", { token: this.token })
        .catch(this.io.problem);
  }
}
