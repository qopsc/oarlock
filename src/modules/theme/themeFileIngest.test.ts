import { expect, it, vi } from "vitest";
import { createThemeFileIngest } from "./themeFileIngest";
import type { Theme } from "./types";

const theme = (name: string): Theme => ({ id: "custom-theme", name, variants: { dark: { colors: { background: "#000" } } } });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

it("does not let an older delayed read overwrite a newer file save", async () => {
  const old = deferred<{ kind: string; content: string; version: string }>();
  const save = vi.fn().mockResolvedValue(undefined);
  const ingest = createThemeFileIngest({
    snapshot: async () => ({ revision: 1, themes: [] }),
    read: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({ kind: "text", content: "new", version: "new-v" }),
    parse: (name) => ({ ok: true, theme: theme(name) }), save, invalid: vi.fn(), failed: vi.fn(),
  });
  const first = ingest.ingest("/theme");
  await flush();
  await ingest.ingest("/theme");
  old.resolve({ kind: "text", content: "old", version: "old-v" });
  await first;
  expect(save).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledWith(theme("new"), 1, "/theme", "new-v");
});

it("does not overwrite another window's newer save after a revision conflict", async () => {
  const snapshots = [ { revision: 1, themes: [theme("before")] }, { revision: 2, themes: [theme("newer")] } ];
  const save = vi.fn().mockRejectedValue("THEME_REVISION_CHANGED");
  const failed = vi.fn();
  const ingest = createThemeFileIngest({ snapshot: vi.fn().mockResolvedValueOnce(snapshots[0]).mockResolvedValueOnce(snapshots[1]),
    read: async () => ({ kind: "text", content: "older", version: "v1" }),
    parse: (name) => ({ ok: true, theme: theme(name) }), save, invalid: vi.fn(), failed });
  await ingest.ingest("/theme");
  expect(save).toHaveBeenCalledOnce();
  expect(failed).not.toHaveBeenCalled();
});

it("retries a conflict caused by an unrelated theme", async () => {
  const save = vi.fn().mockRejectedValueOnce("THEME_REVISION_CHANGED").mockResolvedValueOnce(undefined);
  const snapshots = [ { revision: 1, themes: [theme("before")] }, { revision: 2, themes: [theme("before")] } ];
  const ingest = createThemeFileIngest({ snapshot: vi.fn().mockResolvedValueOnce(snapshots[0]).mockResolvedValueOnce(snapshots[1]),
    read: async () => ({ kind: "text", content: "mine", version: "v1" }),
    parse: (name) => ({ ok: true, theme: theme(name) }), save, invalid: vi.fn(), failed: vi.fn() });
  await ingest.ingest("/theme");
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith(theme("mine"), 2, "/theme", "v1");
});

it("does not publish after its listener is disposed or the file changes", async () => {
  const read = deferred<{ kind: string; content: string; version: string }>();
  const save = vi.fn().mockRejectedValue("THEME_FILE_CHANGED");
  const failed = vi.fn();
  const deps = { snapshot: async () => ({ revision: 1, themes: [] }), read: () => read.promise,
    parse: (name: string) => ({ ok: true as const, theme: theme(name) }), save, invalid: vi.fn(), failed };
  const first = createThemeFileIngest(deps);
  const pending = first.ingest("/theme");
  await flush();
  first.dispose();
  read.resolve({ kind: "text", content: "old", version: "v1" });
  await pending;
  expect(save).not.toHaveBeenCalled();
  await createThemeFileIngest(deps).ingest("/theme");
  expect(failed).not.toHaveBeenCalled();
});
