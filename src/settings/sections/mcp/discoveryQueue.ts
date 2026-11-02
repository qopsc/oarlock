import type { AuthStatus } from "@/modules/mcp/lib/auth";
import { launchKey, type McpServerConfig } from "@/modules/mcp/lib/config";

type Task = {
  server: McpServerConfig;
  key: string;
  controller: AbortController;
  running: boolean;
};
const MAX_ACTIVE = 8;
// Matches native status discovery's existing maximum number of server references.
const MAX_TRACKED = 256;

/** No timers: finishing a request drains the bounded queue. Cancelled requests
 * continue counting until their promise settles, so replacement work cannot fan out. */
export class DiscoveryQueue {
  private tasks = new Map<string, Task>();
  private completed = new Map<string, string>();
  private suspended = new Map<string, string>();
  private active = 0;
  private closed = false;
  constructor(
    private run: (
      server: McpServerConfig,
      signal: AbortSignal,
    ) => Promise<AuthStatus>,
    private report: (
      server: McpServerConfig,
      result: AuthStatus | Error,
    ) => void,
  ) {}
  open() {
    this.closed = false;
  }
  reconcile(servers: readonly McpServerConfig[]) {
    const list = new Map(servers.slice(0, MAX_TRACKED).map((s) => [s.id, s]));
    for (const [id, task] of this.tasks) {
      const server = list.get(id);
      if (!server?.enabled || launchKey(server) !== task.key) {
        this.tasks.delete(id);
        task.controller.abort();
      }
    }
    for (const map of [this.completed, this.suspended]) {
      for (const [id, key] of map) {
        const server = list.get(id);
        if (!server?.enabled || launchKey(server) !== key) map.delete(id);
      }
    }
  }
  sync(servers: readonly McpServerConfig[], statuses: readonly AuthStatus[]) {
    if (this.closed) return;
    const list = new Map(servers.slice(0, MAX_TRACKED).map((s) => [s.id, s]));
    const state = new Map(statuses.map((s) => [s.serverId, s]));
    const eligible = (s: McpServerConfig) =>
      s.enabled &&
      !this.suspended.has(s.id) &&
      state.get(s.id)?.state === "none" &&
      !state.get(s.id)?.signingIn;
    for (const [id, task] of this.tasks) {
      const server = list.get(id);
      if (!server || !eligible(server) || launchKey(server) !== task.key) {
        this.tasks.delete(id);
        task.controller.abort();
      }
    }
    for (const [id, key] of this.completed) {
      const server = list.get(id);
      if (!server?.enabled || launchKey(server) !== key)
        this.completed.delete(id);
    }
    for (const server of list.values()) {
      const key = launchKey(server);
      if (
        eligible(server) &&
        !this.tasks.has(server.id) &&
        this.completed.get(server.id) !== key
      )
        this.tasks.set(server.id, {
          server,
          key,
          controller: new AbortController(),
          running: false,
        });
    }
    this.drain();
  }
  suspend(server: McpServerConfig) {
    const id = server.id;
    this.suspended.set(id, launchKey(server));
    const task = this.tasks.get(id);
    this.tasks.delete(id);
    task?.controller.abort();
    this.completed.delete(id);
  }
  resume(id: string) {
    this.suspended.delete(id);
  }
  retry(id: string) {
    this.completed.delete(id);
  }
  close() {
    this.closed = true;
    for (const task of this.tasks.values()) task.controller.abort();
    this.tasks.clear();
    this.completed.clear();
    this.suspended.clear();
  }
  private drain() {
    if (this.closed) return;
    for (const task of this.tasks.values()) {
      if (this.active >= MAX_ACTIVE) break;
      if (task.running) continue;
      task.running = true;
      ++this.active;
      void Promise.resolve()
        .then(() => {
          task.controller.signal.throwIfAborted();
          return this.run(task.server, task.controller.signal);
        })
        .then(
          (status) => this.finish(task, status),
          (error) =>
            this.finish(
              task,
              error instanceof Error ? error : new Error(String(error)),
            ),
        )
        .finally(() => {
          --this.active;
          this.drain();
        });
    }
  }
  private finish(task: Task, result: AuthStatus | Error) {
    if (
      this.tasks.get(task.server.id) !== task ||
      task.controller.signal.aborted ||
      this.closed
    )
      return;
    this.tasks.delete(task.server.id);
    this.completed.set(task.server.id, task.key);
    this.report(task.server, result);
  }
}
