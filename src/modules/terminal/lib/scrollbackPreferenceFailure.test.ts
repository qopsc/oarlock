import { expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  invoke: vi.fn(async () => new ArrayBuffer(0)),
  init: vi.fn<() => Promise<void>>(async () => { throw new Error("preferences unavailable"); }),
  state: { hydrated: true, syncing: false, error: null as string | null },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocked.invoke }));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({ ...mocked.state, init: mocked.init, terminalBehavior: { restoreScrollback: true } }),
    subscribe: () => () => undefined,
  },
}));

import { terminalScrollback } from "./terminalScrollbackRestore";

it("does not read, save, or delete scrollback when preferences fail to load", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    terminalScrollback.adopt(1, "sb-a");
    const restore = terminalScrollback.takeRestore(1);
    expect(await restore?.result).toBeNull();
    restore?.release();
    await terminalScrollback.persist([1]);
    expect(mocked.invoke).not.toHaveBeenCalled();

    mocked.init.mockResolvedValue();
    mocked.state.error = "synchronization failed";
    await terminalScrollback.persist([1]);
    expect(mocked.invoke).not.toHaveBeenCalled();

    mocked.state.error = null;
    await terminalScrollback.persist([1]);
    expect(mocked.invoke).toHaveBeenCalledWith("terminal_scrollback_retain", { keys: ["sb-a"] });
  } finally {
    warning.mockRestore();
  }
});
