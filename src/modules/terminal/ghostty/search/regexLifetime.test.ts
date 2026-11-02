import { afterEach, expect, it, vi } from "vitest";
import type { GhosttyTerminalModelApi } from "../GhosttyTerminalModel";
import { RegexTerminalSearch } from "./RegexTerminalSearch";
import type { RegexBatch, RegexMatch } from "./regexProtocol";

function fixture() {
  let revision = 0;
  const callbacks: {
    resolve: (matches: RegexMatch[]) => void;
    reject: (error: Error) => void;
  }[] = [];
  const batches: RegexBatch[] = [];
  const dispose = vi.fn();
  const changed = vi.fn();
  const make = vi.fn(() => ({
    dispose,
    run: (batch: RegexBatch) => {
      batches.push(batch);
      return new Promise<RegexMatch[]>((resolve, reject) =>
        callbacks.push({ resolve, reject }),
      );
    },
  }));
  const model = {
    rows: 1,
    revision: () => revision,
    scrollPosition: () => ({ history: 0 }),
    readCellLine: () => ["x"],
    viewportOriginLine: () => 0,
  } as unknown as GhosttyTerminalModelApi;
  const search = new RegexTerminalSearch(model, changed, make);
  search.setQuery("x");
  return {
    search,
    model,
    callbacks,
    batches,
    dispose,
    changed,
    make,
    output: () => {
      revision++;
      search.invalidate();
    },
  };
}
afterEach(() => vi.useRealTimers());
it.each(["query", "clear", "suspend", "dispose", "output"])(
  "revokes a delayed batch on %s",
  async (reason) => {
    vi.useFakeTimers();
    const f = fixture();
    f.search.step(128);
    if (reason === "query") f.search.setQuery("new");
    else if (reason === "output") f.output();
    else f.search[reason as "clear" | "suspend" | "dispose"]();
    f.callbacks[0].resolve([{ line: 0, startColumn: 0, endColumn: 1 }]);
    await Promise.resolve();
    expect(f.search.status().totalMatches).toBe(0);
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
    f.search.dispose();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("coalesces output bursts without repeatedly spawning workers", () => {
  vi.useFakeTimers();
  const f = fixture();
  f.search.step(128);
  for (let i = 0; i < 20; i++) {
    f.output();
    f.search.step(128);
    vi.advanceTimersByTime(10);
  }
  expect(f.make).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(100);
  f.search.step(128);
  expect(f.make).toHaveBeenCalledTimes(2);
  f.search.dispose();
});
it("keeps errors visible through output and retries only explicitly", async () => {
  const f = fixture();
  f.search.step(128);
  f.callbacks[0].reject(new Error("Regex search timed out"));
  await Promise.resolve();
  f.output();
  f.search.step(128);
  expect(f.make).toHaveBeenCalledOnce();
  expect(f.search.failure()).toContain("timed out");
  f.search.retry();
  f.search.step(128);
  expect(f.make).toHaveBeenCalledTimes(2);
  f.search.dispose();
});
it("bounds batches even when the caller requests thousands of rows", () => {
  const f = fixture();
  Object.assign(f.model, {
    rows: 2000,
    readCellLine: () => Array(1024).fill("x"),
  });
  f.search.setQuery("x");
  f.search.step(2000);
  expect(f.batches[0].lines.length).toBeLessThanOrEqual(64);
  expect(f.batches[0].lines.length).toBeGreaterThan(0);
  f.search.dispose();
});
it("refuses oversized rows and patterns without starting a worker", () => {
  const f = fixture();
  Object.assign(f.model, { readCellLine: () => ["x".repeat(131073)] });
  f.search.step(128);
  expect(f.search.failure()).toContain("row is too large");
  f.search.setQuery("x".repeat(4097));
  expect(f.search.failure()).toContain("too long");
  expect(f.make).not.toHaveBeenCalled();
  f.search.dispose();
});

it("refuses cumulative history beyond the byte budget without keeping partial results", async () => {
  const f = fixture();
  Object.assign(f.model, {
    rows: 100,
    readCellLine: () => ["x".repeat(131072)],
  });
  f.search.setQuery("x");
  for (let i = 0; i < 64; i++) {
    f.search.step(128);
    f.callbacks[i].resolve([]);
    await Promise.resolve();
  }
  f.search.step(128);
  expect(f.search.failure()).toContain("history is too large");
  expect(f.batches).toHaveLength(64);
  expect(f.search.status().totalMatches).toBe(0);
  f.search.dispose();
});

it("bounds total scan time across individually successful batches", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(1);
  const f = fixture();
  Object.assign(f.model, { rows: 1000 });
  try {
    f.search.setQuery("x");
    f.search.step(1);
    f.callbacks[0].resolve([]);
    await Promise.resolve();
    now.mockReturnValue(10002);
    f.search.step(1);
    expect(f.search.failure()).toContain("took too long");
    expect(f.batches).toHaveLength(1);
  } finally {
    f.search.dispose();
    now.mockRestore();
  }
});
