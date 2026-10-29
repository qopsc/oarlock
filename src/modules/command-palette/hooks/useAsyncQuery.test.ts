import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A small hook driver preserves dependency identity and runs effect cleanups.
const hooks = vi.hoisted(() => ({
  cells: [] as unknown[],
  index: 0,
  effects: [] as (() => void)[],
  cleanups: new Set<() => void>(),
  writes: 0,
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const i = hooks.index++;
    if (!(i in hooks.cells)) hooks.cells[i] = initial;
    return [
      hooks.cells[i],
      (value: unknown) => {
        hooks.writes++;
        hooks.cells[i] =
          typeof value === "function" ? value(hooks.cells[i]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = hooks.index++;
    hooks.cells[i] ??= { current: initial };
    return hooks.cells[i];
  },
  useCallback: (fn: unknown, deps: unknown[]) => {
    const i = hooks.index++;
    const old = hooks.cells[i] as { fn: unknown; deps: unknown[] } | undefined;
    if (!old || deps.some((d, j) => !Object.is(d, old.deps[j])))
      hooks.cells[i] = { fn, deps };
    return (hooks.cells[i] as { fn: unknown }).fn;
  },
  useEffect: (fn: () => (() => void) | undefined, deps: unknown[]) => {
    const i = hooks.index++;
    const old = hooks.cells[i] as
      | { deps: unknown[]; cleanup?: () => void }
      | undefined;
    if (!old || deps.some((d, j) => !Object.is(d, old.deps[j]))) {
      hooks.effects.push(() => {
        old?.cleanup?.();
        if (old?.cleanup) hooks.cleanups.delete(old.cleanup);
        const cleanup = fn();
        hooks.cells[i] = { deps, cleanup };
        if (cleanup) hooks.cleanups.add(cleanup);
      });
    }
  },
}));
const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  env: { kind: "wsl", distro: "Ubuntu" },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => native.env,
  useWorkspaceEnvStore: (
    select: (state: { env: typeof native.env }) => unknown,
  ) => select({ env: native.env }),
  workspaceScopeKey: (env: typeof native.env) => JSON.stringify(env),
}));
vi.mock("@/modules/spaces/lib/useSpaces", () => ({
  useSpaces: Object.assign(
    (select: (state: { activeId: string }) => unknown) =>
      select({ activeId: "space" }),
    { getState: () => ({ activeId: "space" }) },
  ),
}));
vi.mock("./requestContentSearch", () => ({
  requestContentSearch: (args: unknown, signal: AbortSignal) =>
    native.invoke("fs_grep_interactive", args, signal),
}));
import { useAsyncQuery } from "./useAsyncQuery";
import {
  useContentSearch,
  contentSearchOwnerCurrent,
} from "./useContentSearch";
function render<T>(hook: () => T): T {
  hooks.index = 0;
  const value = hook();
  for (const effect of hooks.effects.splice(0)) effect();
  return value;
}
function unmount() {
  for (const cleanup of hooks.cleanups) cleanup();
  hooks.cleanups.clear();
}
beforeEach(() => {
  hooks.cells = [];
  hooks.index = 0;
  hooks.effects = [];
  hooks.writes = 0;
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  native.invoke.mockReset().mockResolvedValue({
    hits: [{ path: "/repo/a", rel: "a", line: 1, text: "Ubuntu hit" }],
    truncated: false,
  });
  native.env = { kind: "wsl", distro: "Ubuntu" };
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("Retry replaces the queued debounce instead of dispatching twice", async () => {
  const run = vi.fn(async () => "fresh");
  const state = render(() =>
    useAsyncQuery({
      enabled: true,
      term: "needle",
      minLength: 2,
      debounceMs: 140,
      run,
      empty: "",
    }),
  );
  state.retry();
  await vi.advanceTimersByTimeAsync(200);
  expect(run).toHaveBeenCalledOnce();
});
it("does not publish a request reply after unmount", async () => {
  const request = deferred<string>();
  render(() =>
    useAsyncQuery({
      enabled: true,
      term: "needle",
      minLength: 2,
      debounceMs: 140,
      run: () => request.promise,
      empty: "",
    }),
  );
  await vi.advanceTimersByTimeAsync(140);
  unmount();
  const writes = hooks.writes;
  request.resolve("late");
  await vi.advanceTimersByTimeAsync(0);
  expect(hooks.writes).toBe(writes);
});
it("searches again when the same root belongs to another distribution", async () => {
  const hook = () =>
    useContentSearch("/repo", "needle", true, {
      channel: "sidebar",
      keepPrevious: true,
    });
  render(hook);
  await vi.advanceTimersByTimeAsync(140);
  expect(render(hook).results[0].text).toBe("Ubuntu hit");
  native.env = { kind: "wsl", distro: "Debian" };
  expect(render(hook).results).toEqual([]);
  expect(native.invoke.mock.calls[0][2].aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(140);
  expect(native.invoke).toHaveBeenCalledTimes(2);
  expect(native.invoke.mock.calls[1][1].workspace.distro).toBe("Debian");
});

it("retains a newer query when an obsolete request finishes", async () => {
  const old = deferred<string>();
  const run = vi.fn((term: string) =>
    term === "old" ? old.promise : Promise.resolve("new result"),
  );
  const hook = (term: string) =>
    useAsyncQuery({
      enabled: true,
      term,
      minLength: 2,
      debounceMs: 140,
      run,
      empty: "",
    });
  render(() => hook("old"));
  await vi.advanceTimersByTimeAsync(140);
  render(() => hook("new"));
  await vi.advanceTimersByTimeAsync(140);
  old.resolve("old result");
  await vi.advanceTimersByTimeAsync(0);
  expect(render(() => hook("new")).results).toBe("new result");
});
it("turns a synchronous runner failure into a recoverable error", async () => {
  const run = () => {
    throw new Error("unavailable");
  };
  const hook = () =>
    useAsyncQuery({
      enabled: true,
      term: "needle",
      minLength: 2,
      debounceMs: 140,
      run,
      empty: "",
    });
  render(hook);
  await vi.advanceTimersByTimeAsync(140);
  expect(render(hook)).toMatchObject({
    loading: false,
    error: "Error: unavailable",
  });
});

it("rejects opening a result from a different environment", () => {
  expect(
    contentSearchOwnerCurrent({
      env: { kind: "wsl", distro: "Debian" },
      spaceId: "space",
      root: "/repo",
    }),
  ).toBe(false);
  expect(
    contentSearchOwnerCurrent({
      env: { kind: "wsl", distro: "Ubuntu" },
      spaceId: "space",
      root: "/repo",
    }),
  ).toBe(true);
});
it("aborts native work on close and rejects its late result", async () => {
  const pending = deferred<{
    hits: [];
    truncated: boolean;
    cancelled: boolean;
  }>();
  native.invoke.mockReturnValue(pending.promise);
  const hook = (enabled: boolean) =>
    useContentSearch("/repo", "needle", enabled);
  render(() => hook(true));
  await vi.advanceTimersByTimeAsync(140);
  render(() => hook(false));
  expect(native.invoke.mock.calls[0][2].aborted).toBe(true);
  pending.resolve({ hits: [], truncated: false, cancelled: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(render(() => hook(false))).toMatchObject({
    results: [],
    error: null,
    loading: false,
  });
});
