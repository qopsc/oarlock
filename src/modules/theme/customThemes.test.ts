import { beforeEach, expect, it, vi } from "vitest";
import type { Theme } from "./types";
const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  receive: undefined as undefined | ((event: { payload: unknown }) => void),
  stop: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
const theme = (id: string): Theme => ({
  id,
  name: id,
  variants: { dark: { colors: { background: "#000" } } },
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  native.listen.mockImplementation(
    async (_name: string, receive: typeof native.receive) => {
      native.receive = receive;
      return native.stop;
    },
  );
});
it("submits only the selected theme batch or deletion to native", async () => {
  const mod = await import("./customThemes");
  native.invoke.mockResolvedValue({ revision: 1, themes: [theme("theme-a")] });
  await mod.saveCustomTheme(theme("theme-a"));
  expect(native.invoke).toHaveBeenCalledWith("themes_mutate", {
    change: { kind: "upsert", themes: [theme("theme-a")] },
  });
  await mod.deleteCustomTheme("theme-b");
  expect(native.invoke).toHaveBeenLastCalledWith("themes_mutate", {
    change: { kind: "delete", id: "theme-b" },
  });
  expect(native.invoke.mock.calls.every((c) => c[0] === "themes_mutate")).toBe(
    true,
  );
});
it("does not invoke for an empty import", async () => {
  const mod = await import("./customThemes");
  await mod.saveCustomThemes([]);
  expect(native.invoke).not.toHaveBeenCalled();
});
it("creates imports without using the overwrite operation", async () => {
  const mod = await import("./customThemes");
  native.invoke.mockResolvedValue({ revision: 1, themes: [theme("new-theme")] });
  await mod.createImportedThemes([theme("new-theme")]);
  expect(native.invoke).toHaveBeenCalledWith("themes_mutate", {
    change: { kind: "create", themes: [theme("new-theme")] },
  });
});
it("subscribes before its initial read and rejects a stale startup snapshot", async () => {
  const mod = await import("./customThemes");
  let done: (value: unknown) => void = () => {};
  native.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const changed = vi.fn(),
    failed = vi.fn();
  const stop = await mod.watchCustomThemes(changed, failed);
  expect(native.listen.mock.invocationCallOrder[0]).toBeLessThan(
    native.invoke.mock.invocationCallOrder[0],
  );
  native.receive?.({ payload: { revision: 2, themes: [theme("new-theme")] } });
  done({ revision: 1, themes: [theme("old-theme")] });
  await flush();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenLastCalledWith({
    revision: 2,
    themes: [theme("new-theme")],
  });
  stop();
  expect(native.stop).toHaveBeenCalledOnce();
});
it("events and command replies cannot regress or duplicate an observer", async () => {
  const mod = await import("./customThemes");
  native.invoke.mockResolvedValueOnce({ revision: 0, themes: [] });
  const changed = vi.fn();
  const stop = await mod.watchCustomThemes(changed, vi.fn());
  await flush();
  changed.mockClear();
  native.invoke.mockResolvedValueOnce({
    revision: 1,
    themes: [theme("old-theme")],
  });
  native.receive?.({ payload: { revision: 2, themes: [theme("new-theme")] } });
  await mod.saveCustomTheme(theme("old-theme"));
  native.receive?.({ payload: { revision: 2, themes: [theme("new-theme")] } });
  expect(changed).toHaveBeenCalledOnce();
  expect(changed.mock.calls[0][0].revision).toBe(2);
  stop();
});
it("load failure is reported without writing defaults; retry can recover", async () => {
  const mod = await import("./customThemes");
  native.invoke.mockRejectedValueOnce(Error("damaged file preserved"));
  const changed = vi.fn(),
    failed = vi.fn();
  let stop = await mod.watchCustomThemes(changed, failed);
  await flush();
  expect(failed).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
  stop();
  native.invoke.mockResolvedValueOnce({ revision: 0, themes: [] });
  stop = await mod.watchCustomThemes(changed, failed);
  await flush();
  expect(changed).toHaveBeenCalledWith({ revision: 0, themes: [] });
  expect(
    native.invoke.mock.calls.every((c) => c[0] === "themes_snapshot"),
  ).toBe(true);
  stop();
});
it("retired watchers ignore late reads and already queued events", async () => {
  const mod = await import("./customThemes");
  let done: (value: unknown) => void = () => {};
  native.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const changed = vi.fn();
  const stop = await mod.watchCustomThemes(changed, vi.fn());
  stop();
  native.receive?.({ payload: { revision: 2, themes: [theme("new-theme")] } });
  done({ revision: 1, themes: [] });
  await flush();
  expect(changed).not.toHaveBeenCalled();
});
it("registration failure removes its observer", async () => {
  const mod = await import("./customThemes");
  native.listen.mockRejectedValueOnce(Error("no events"));
  const changed = vi.fn();
  await expect(mod.watchCustomThemes(changed, vi.fn())).rejects.toThrow(
    "no events",
  );
  native.invoke.mockResolvedValueOnce({ revision: 1, themes: [] });
  await mod.saveCustomTheme(theme("theme-a"));
  expect(changed).not.toHaveBeenCalled();
});
it("failed writes do not announce uncommitted themes", async () => {
  const mod = await import("./customThemes");
  native.invoke.mockResolvedValueOnce({ revision: 1, themes: [] });
  const changed = vi.fn();
  const stop = await mod.watchCustomThemes(changed, vi.fn());
  await flush();
  changed.mockClear();
  native.invoke.mockRejectedValueOnce(Error("disk failure"));
  await expect(mod.saveCustomTheme(theme("theme-a"))).rejects.toThrow(
    "disk failure",
  );
  expect(changed).not.toHaveBeenCalled();
  stop();
});

it("a stale initial read failure cannot undo recovery from a newer event", async () => {
  const mod = await import("./customThemes");
  let reject: (error: unknown) => void = () => {};
  native.invoke.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const changed = vi.fn(),
    failed = vi.fn();
  const stop = await mod.watchCustomThemes(changed, failed);
  native.receive?.({ payload: { revision: 3, themes: [theme("new-theme")] } });
  reject(Error("old read failed"));
  await flush();
  expect(failed).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
  stop();
});
