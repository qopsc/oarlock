import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  receive: undefined as undefined | ((event: { payload: unknown }) => void),
  settle: undefined as undefined | ((stop: () => void) => void),
  unsubscribe: vi.fn(),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({ shortcuts: {} }),
    subscribe: () => fake.unsubscribe,
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    listen: (_event: string, receive: typeof fake.receive) => {
      fake.receive = receive;
      return new Promise<() => void>((resolve) => {
        fake.settle = resolve;
      });
    },
  }),
}));
import { startMenuBridge } from "./menuBridge";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());
it("ignores a menu event queued after teardown while registration was pending", async () => {
  const run = vi.fn();
  const stop = startMenuBridge(run);
  stop();
  fake.receive?.({ payload: { id: "tab.new" } });
  expect(run).not.toHaveBeenCalled();
  const unlisten = vi.fn();
  fake.settle?.(unlisten);
  await Promise.resolve();
  expect(unlisten).toHaveBeenCalledOnce();
  expect(fake.unsubscribe).toHaveBeenCalledOnce();
});
it("dispatches while live, then ignores queued events after registered teardown", async () => {
  const run = vi.fn(),
    unlisten = vi.fn();
  const stop = startMenuBridge(run);
  fake.settle?.(unlisten);
  await Promise.resolve();
  fake.receive?.({ payload: { id: "tab.new" } });
  expect(run).toHaveBeenCalledWith({ id: "tab.new" });
  stop();
  fake.receive?.({ payload: { id: "tab.new" } });
  expect(run).toHaveBeenCalledOnce();
  expect(unlisten).toHaveBeenCalledOnce();
});
