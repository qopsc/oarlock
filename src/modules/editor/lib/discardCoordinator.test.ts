import { afterEach, expect, it, vi } from "vitest";
import {
  DiscardCoordinator,
  type DiscardEvent,
  type DiscardScope,
} from "./discardCoordinator";
import { DocumentSession } from "./documentSession";

const workspace = { kind: "local" } as const;
const request = {
  repoRoot: "/repo",
  entries: [{ path: "file", untracked: false }],
  workspace,
};
const event = (phase: DiscardEvent["phase"] = "prepare"): DiscardEvent => ({
  id: "1",
  token: "page",
  nonce: "nonce",
  owner: false,
  paths: ["/repo/file"],
  workspace,
  phase,
});
const clients: DiscardCoordinator[] = [];
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function setup(
  invoke = vi.fn<
    (command: string, args: Record<string, unknown>) => Promise<unknown>
  >(async () => undefined),
) {
  const preparation = { complete: vi.fn(), dispose: vi.fn() };
  const prepare = vi.fn(
    (_scope: DiscardScope, _preserve: boolean) => preparation,
  );
  const problem = vi.fn();
  const client = new DiscardCoordinator({
    invoke: invoke as never,
    prepare,
    problem,
  });
  clients.push(client);
  return { client, preparation, prepare, invoke, problem };
}
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers();
});

it("queues events until registration completes and rejects other page tokens", () => {
  const t = setup();
  t.client.receive(event());
  expect(t.prepare).not.toHaveBeenCalled();
  t.client.ready("page");
  expect(t.prepare).toHaveBeenCalledWith(event(), true);
  t.client.receive({ ...event("complete"), token: "old" });
  expect(t.preparation.complete).not.toHaveBeenCalled();
  t.client.receive(event("complete"));
  t.client.receive(event("complete"));
  t.client.receive(event());
  expect(t.preparation.complete).toHaveBeenCalledOnce();
  expect(t.prepare).toHaveBeenCalledOnce();
});
it("reconciles a lost completion while retaining protection during a running worker", async () => {
  const t = setup();
  t.client.ready("page");
  t.client.receive(event());
  t.invoke.mockResolvedValue({ phase: "running", ok: false });
  await t.client.reconcile();
  expect(t.preparation.dispose).not.toHaveBeenCalled();
  expect(t.preparation.complete).not.toHaveBeenCalled();
  t.invoke.mockResolvedValue({ phase: "finished", ok: true });
  await t.client.reconcile();
  expect(t.preparation.complete).toHaveBeenCalledOnce();
});
it("retries failed settlement without repeating editor completion", async () => {
  vi.useFakeTimers();
  const t = setup();
  t.client.ready("page");
  t.invoke.mockRejectedValueOnce(new Error("lost ack"));
  t.client.receive(event("complete"));
  await flush();
  expect(t.problem).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  await flush();
  expect(t.preparation.complete).toHaveBeenCalledOnce();
  expect(
    t.invoke.mock.calls.filter(([cmd]) => cmd === "git_discard_settled"),
  ).toHaveLength(2);
  const calls = t.invoke.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(t.invoke.mock.calls.length).toBe(calls);
});
it("captures origin revisions before begin and does not recapture its prepare event", async () => {
  const t = setup();
  t.client.ready("page");
  t.invoke.mockImplementation(async (command, args) => {
    if (command === "git_discard_begin") {
      expect(t.prepare).toHaveBeenCalledOnce();
      t.client.receive({
        ...event(),
        owner: true,
        nonce: args.nonce as string,
      });
      return "1";
    }
  });
  await t.client.execute(request);
  expect(t.prepare).toHaveBeenCalledOnce();
  expect(t.prepare.mock.calls[0][1]).toBe(false);
  expect(t.preparation.complete).toHaveBeenCalledOnce();
});
it("a failed begin never executes Git and restores its local preparation", async () => {
  const t = setup();
  t.client.ready("page");
  t.invoke.mockRejectedValue(new Error("unready window"));
  await expect(t.client.execute(request)).rejects.toThrow("unready");
  expect(t.preparation.dispose).toHaveBeenCalledOnce();
  expect(t.invoke.mock.calls.map(([command]) => command)).toEqual([
    "git_discard_begin",
  ]);
});
it("an ambiguous execution error never releases a still-running worker", async () => {
  const t = setup();
  t.client.ready("page");
  t.invoke.mockImplementation(async (command) => {
    if (command === "git_discard_begin") return "1";
    if (command === "git_discard") throw new Error("reply lost");
    if (command === "git_discard_cancel")
      return { phase: "running", ok: false };
  });
  await expect(t.client.execute(request)).rejects.toThrow("reply lost");
  expect(t.preparation.dispose).not.toHaveBeenCalled();
  t.client.receive(event("complete"));
  expect(t.preparation.complete).toHaveBeenCalledOnce();
});
it("a page disposed during registration unregisters the late token", () => {
  const t = setup();
  t.client.dispose();
  t.client.ready("late");
  expect(t.invoke).toHaveBeenCalledWith("git_discard_unregister", {
    token: "late",
  });
  t.client.receive(event());
  expect(t.prepare).not.toHaveBeenCalled();
});
it("refuses overlapping submissions before they can invalidate the first snapshot", async () => {
  const t = setup();
  t.client.ready("page");
  let resolve!: (id: string) => void;
  t.invoke.mockImplementation(async (command) =>
    command === "git_discard_begin"
      ? new Promise<string>((done) => {
          resolve = done;
        })
      : undefined,
  );
  const first = t.client.execute(request);
  await expect(t.client.execute(request)).rejects.toThrow("Another Discard");
  expect(t.prepare).toHaveBeenCalledOnce();
  resolve("1");
  await first;
});
it("preserves text autosaved in another window before and after preparation", async () => {
  let disk = "working tree";
  const host = {
    state: vi.fn(),
    dirty: vi.fn(),
    saved: vi.fn(),
    saveFailed: vi.fn(),
    conflict: vi.fn(),
    released: vi.fn(),
    autoSave: () => ({ enabled: false, delay: 50 }),
  };
  const io = {
    read: async () => ({
      kind: "text" as const,
      content: disk,
      version: disk,
      size: disk.length,
      mtime: 1,
    }),
    write: async (_path: string, content: string) => {
      disk = content;
      return { kind: "saved" as const, version: content };
    },
  };
  const a = new DocumentSession(io, host),
    b = new DocumentSession(io, host);
  a.open("/repo/file");
  b.open("/repo/file");
  await flush();
  b.change("typed before the other window receives preparation");
  await b.save();
  let finish!: () => void;
  let remote!: DiscardCoordinator;
  const origin = new DiscardCoordinator({
    problem: vi.fn(),
    prepare: (_scope, preserve) => a.prepareDiscard(preserve),
    invoke: async <T>(command: string) => {
      if (command === "git_discard_begin") {
        remote.receive(event());
        return "1" as T;
      }
      if (command === "git_discard")
        return await new Promise<T>((resolve) => {
          finish = () => {
            disk = "HEAD";
            remote.receive(event("complete"));
            resolve(undefined as T);
          };
        });
      return undefined as T;
    },
  });
  remote = new DiscardCoordinator({
    problem: vi.fn(),
    prepare: (_scope, preserve) => b.prepareDiscard(preserve),
    invoke: async <T>() => undefined as T,
  });
  clients.push(origin, remote);
  origin.ready("origin");
  remote.ready("page");
  const running = origin.execute(request);
  await flush();
  expect(b.hasUnsavedChanges()).toBe(true);
  expect(b.isSaved()).toBe(false);
  b.change("new work in window B");
  await b.save();
  expect(b.isSaved()).toBe(false);
  expect(b.reload()).toBe(false);
  finish();
  await running;
  await flush();
  b.reload();
  await flush();
  expect(a.text()).toBe("HEAD");
  expect(b.text()).toBe("new work in window B");
  expect(b.hasUnsavedChanges()).toBe(true);
  a.close();
  b.close();
});
