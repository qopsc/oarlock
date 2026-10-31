import { beforeEach, expect, it, vi } from "vitest";
import type { SessionMeta } from "./sessions";

type Snapshot = { revision: number; sessions: SessionMeta[] };
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  event: null as ((event: { payload: Snapshot }) => void) | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, fn: typeof mocks.event) => {
    mocks.event = fn;
    return () => {};
  },
}));
vi.mock("@tauri-apps/plugin-store", () => ({ LazyStore: class {} }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const meta = (id: string, title = id): SessionMeta => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1,
});

beforeEach(() => {
  vi.resetModules();
  mocks.invoke.mockReset();
  mocks.event = null;
});

it("ignores stale snapshots and keeps local pending creations during foreign notifications", async () => {
  const sessions = await import("./sessions");
  let finish: ((value: Snapshot) => void) | undefined;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "ai_sessions_snapshot")
      return { revision: 1, sessions: [meta("existing")] };
    return new Promise<Snapshot>((resolve) => {
      finish = resolve;
    });
  });
  const changed = vi.fn();
  const off = await sessions.onSessionsChanged(changed);
  const pending = sessions.saveSessionsList(
    [meta("new"), meta("existing")],
    [meta("existing")],
  );
  await vi.waitFor(() => expect(finish).toBeDefined());
  mocks.event?.({
    payload: {
      revision: 3,
      sessions: [meta("foreign"), meta("existing", "latest")],
    },
  });
  expect(changed).toHaveBeenLastCalledWith([
    meta("new"),
    meta("foreign"),
    meta("existing", "latest"),
  ]);
  finish?.({ revision: 2, sessions: [meta("new"), meta("existing")] });
  await pending;
  expect(changed).toHaveBeenLastCalledWith([
    meta("foreign"),
    meta("existing", "latest"),
  ]);
  mocks.event?.({ payload: { revision: 1, sessions: [] } });
  expect(changed).toHaveBeenLastCalledWith([
    meta("foreign"),
    meta("existing", "latest"),
  ]);
  off();
});

it("retries a failed rename before a newer rename, preserving user order", async () => {
  const sessions = await import("./sessions");
  const changes: string[] = [];
  let fail = true;
  let revision = 0;
  mocks.invoke.mockImplementation(
    async (
      _command: string,
      args: { delta: { updates: { patch: { title: string } }[] } },
    ) => {
      const title = args.delta.updates[0].patch.title;
      changes.push(title);
      if (fail) {
        fail = false;
        throw new Error("temporarily unavailable");
      }
      return { revision: ++revision, sessions: [meta("a", title)] };
    },
  );
  await expect(
    sessions.saveSessionsList([meta("a", "first")], [meta("a")]),
  ).rejects.toThrow("temporarily unavailable");
  await sessions.saveSessionsList([meta("a", "second")], [meta("a", "first")]);
  expect(changes).toEqual(["first", "first", "second"]);
});
