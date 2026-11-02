import { afterEach, expect, it, vi } from "vitest";
import { startRegex } from "./regexClient";
import { MAX_TEXT_UNITS, type RegexInput } from "./regexTypes";
const input: RegexInput = {
  text: "x",
  spec: {
    search: "x",
    replace: "Y",
    regexp: true,
    wholeWord: false,
    literal: false,
    caseSensitive: false,
  },
};
function port() {
  return {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  } as unknown as Worker;
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("terminates hostile work at its deadline and returns admission", async () => {
  vi.useFakeTimers();
  const worker = port();
  const task = startRegex(input, () => worker, 100);
  const result = task.result.catch((e) => e.message);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toContain("timed out");
  expect(worker.terminate).toHaveBeenCalledOnce();
  task.cancel();
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("cancels exact work and rejects late replies", async () => {
  const worker = port();
  const task = startRegex(input, () => worker);
  const callback = worker.onmessage;
  if (!callback) throw new Error("Missing handler");
  const result = task.result.catch((e) => e.message);
  task.cancel();
  callback.call(worker, {
    data: { matches: [{ from: 0, to: 1, insert: "Y" }] },
  } as MessageEvent);
  expect(await result).toContain("cancelled");
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it("bounds admission and input before cloning", async () => {
  const factory = vi.fn(port);
  expect(() =>
    startRegex({ ...input, text: "x".repeat(MAX_TEXT_UNITS + 1) }, factory),
  ).toThrow("too large");
  expect(factory).not.toHaveBeenCalled();
  const tasks = Array.from({ length: 4 }, () => startRegex(input, factory));
  const results = tasks.map((task) => task.result.catch((e) => e.message));
  expect(() => startRegex(input, factory)).toThrow("Too many");
  for (const task of tasks) task.cancel();
  await Promise.all(results);
});
it("rejects a late reply before the timer callback and rejects malformed output", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const worker = port();
  const task = startRegex(input, () => worker, 10);
  const result = task.result.catch((e) => e.message);
  clock.mockReturnValue(11);
  worker.onmessage?.call(worker, { data: { matches: [] } } as MessageEvent);
  expect(await result).toContain("timed out");
  const next = port();
  const other = startRegex(input, () => next);
  const error = other.result.catch((e) => e.message);
  next.onmessage?.call(next, {
    data: { matches: [{ from: 0, to: 5, insert: "wrong" }] },
  } as MessageEvent);
  expect(await error).toContain("invalid matches");
});
