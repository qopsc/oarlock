import { afterEach, expect, it, vi } from "vitest";
import { createRegexRunner } from "./regexWorkerClient";
import { REGEX_BATCH_UNITS, type RegexBatch } from "./regexProtocol";

const batch: RegexBatch = {
  pattern: "x",
  lines: [["x"]],
  firstLine: 0,
  limit: 10,
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
it("rejects a late reply even when the timeout callback has not run", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  const worker = port();
  const runner = createRegexRunner(() => worker);
  const result = runner.run(batch, 100).catch((error) => error.message);
  now.mockReturnValue(101);
  worker.onmessage?.call(worker, {
    data: { id: 1, matches: [] },
  } as MessageEvent);
  expect(await result).toContain("timed out");
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it("terminates a stalled worker and rejects the request at its deadline", async () => {
  vi.useFakeTimers();
  const worker = port();
  const runner = createRegexRunner(() => worker);
  const result = runner.run(batch, 50).catch((error) => error.message);
  vi.advanceTimersByTime(50);
  expect(await result).toContain("timed out");
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.onmessage).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  runner.dispose();
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it("cancels without retaining timers or admitting late messages", async () => {
  vi.useFakeTimers();
  const worker = port();
  const runner = createRegexRunner(() => worker);
  const reply = worker.onmessage;
  if (!reply) throw new Error("Missing worker reply handler");
  const result = runner.run(batch, 1000).catch((error) => error.message);
  runner.dispose();
  reply.call(worker, {
    data: { id: 1, matches: [{ line: 0, startColumn: 0, endColumn: 1 }] },
  } as MessageEvent);
  expect(await result).toContain("cancelled");
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds worker admission and returns slots after disposal", () => {
  const runners = Array.from({ length: 4 }, () => createRegexRunner(port));
  try {
    expect(() => createRegexRunner(port)).toThrow("Too many");
  } finally {
    for (const runner of runners) runner.dispose();
  }
  createRegexRunner(port).dispose();
});
it("refuses oversized input before structured cloning", async () => {
  const worker = port();
  const runner = createRegexRunner(() => worker);
  await expect(
    runner.run(
      { ...batch, lines: [["x".repeat(REGEX_BATCH_UNITS + 1)]] },
      1000,
    ),
  ).rejects.toThrow("too large");
  expect(worker.postMessage).not.toHaveBeenCalled();
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it("returns worker failures and rejects malformed spans", async () => {
  for (const reply of [
    { error: "Invalid regex" },
    { matches: [{ line: 0, startColumn: 0, endColumn: 99 }] },
  ]) {
    const worker = port();
    const runner = createRegexRunner(() => worker);
    const result = runner.run(batch, 1000).catch((error) => error.message);
    worker.onmessage?.call(worker, {
      data: { id: 1, ...reply },
    } as MessageEvent);
    expect(await result).toMatch(/Invalid regex|invalid matches/);
    expect(worker.terminate).toHaveBeenCalledOnce();
  }
});
