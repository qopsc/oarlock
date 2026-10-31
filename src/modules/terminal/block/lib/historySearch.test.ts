import { afterEach, expect, it, vi } from "vitest";
import { HistorySearch } from "./historySearch";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

it("does not reopen after cancellation or replace a newer result", async () => {
  const pending: ((items: string[]) => void)[] = [];
  const search = new HistorySearch(() => new Promise((resolve) => { pending.push(resolve); }));
  const apply = vi.fn();
  search.start("old", 200, 0, apply);
  await flush();
  search.start("new", 200, 0, apply);
  await flush();
  pending[1](["new"]); pending[0](["old"]);
  await flush();
  expect(apply).toHaveBeenCalledExactlyOnceWith(["new"]);
  search.start("dismissed", 200, 0, apply);
  await flush();
  expect(search.pending()).toBe(true);
  search.cancel();
  pending[2](["dismissed"]);
  await flush();
  expect(apply).toHaveBeenCalledOnce();
});

it("cancels debounce and ignores callbacks after destruction", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue(["match"]);
  const apply = vi.fn();
  const search = new HistorySearch(fetch);
  search.start("query", 200, 60, apply);
  search.dispose();
  await vi.advanceTimersByTimeAsync(100);
  expect(fetch).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});

it("handles rejected lookups without leaving a pending request", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const search = new HistorySearch(async () => { throw new Error("unavailable"); });
  const apply = vi.fn();
  search.start("query", 200, 0, apply);
  await flush();
  expect(search.pending()).toBe(false);
  expect(apply).not.toHaveBeenCalled();
});
