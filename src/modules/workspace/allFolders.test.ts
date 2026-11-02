import { expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { syncAllFolders, useAllFolders } from "./allFolders";
it("mirrors committed preferences without letting windows overwrite native permission gates", () => {
  let state = { appAllFolders: true, aiAllFolders: false };
  const listeners = new Set<(next: typeof state) => void>();
  const stop = syncAllFolders({
    getState: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
  expect(useAllFolders.getState()).toEqual({ app: true, ai: false });
  state = { appAllFolders: false, aiAllFolders: true };
  for (const fn of listeners) fn(state);
  expect(useAllFolders.getState()).toEqual({ app: false, ai: true });
  expect(invoke).not.toHaveBeenCalled();
  stop();
  expect(listeners.size).toBe(0);
});
