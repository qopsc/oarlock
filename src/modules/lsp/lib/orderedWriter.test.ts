import { afterEach, expect, it, vi } from "vitest";
import { OrderedLspWriter, LSP_WRITE_BYTES, utf8Size } from "./orderedWriter";

afterEach(() => vi.useRealTimers());
it("matches UTF-8 encoding, including astral and unpaired surrogates", () => {
  for (const text of [
    "ascii",
    "é中",
    "😀",
    "\ud800x\udc00",
    "\ud800\ud800\udc00",
  ])
    expect(utf8Size(text)).toBe(new TextEncoder().encode(text).byteLength);
});
it("counts in-flight bytes, fails once on overflow and discards pending work", async () => {
  let finish!: () => void;
  const write = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const failed = vi.fn();
  const writer = new OrderedLspWriter(write, failed);
  writer.send("é".repeat(LSP_WRITE_BYTES / 2));
  expect(write).toHaveBeenCalledTimes(1);
  writer.send("x");
  writer.send("again");
  finish();
  await Promise.resolve();
  expect(write).toHaveBeenCalledTimes(1);
  expect(failed).toHaveBeenCalledTimes(1);
});
it("releases capacity after acknowledgment and has no timer while idle", async () => {
  vi.useFakeTimers();
  const write = vi.fn(async () => {});
  const failed = vi.fn();
  const writer = new OrderedLspWriter(write, failed);
  for (let i = 0; i < 300; i++) {
    writer.send("change");
    await Promise.resolve();
  }
  expect(write).toHaveBeenCalledTimes(300);
  expect(vi.getTimerCount()).toBe(0);
  expect(failed).not.toHaveBeenCalled();
});
it("terminates after 30 seconds and ignores late acknowledgment", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const write = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const failed = vi.fn();
  const writer = new OrderedLspWriter(write, failed);
  writer.send("open");
  writer.send("change");
  vi.advanceTimersByTime(29_999);
  expect(failed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(failed).toHaveBeenCalledWith(expect.stringContaining("30 seconds"));
  finish();
  await Promise.resolve();
  expect(write).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("closing cancels the timer and ignores a delayed failure", async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const failed = vi.fn();
  const writer = new OrderedLspWriter(
    () =>
      new Promise((_, no) => {
        reject = no;
      }),
    failed,
  );
  writer.send("open");
  writer.send("change");
  writer.close();
  reject(new Error("late"));
  await Promise.resolve();
  expect(failed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("fails on a rejected or synchronously throwing write without sending later edits", async () => {
  for (const sync of [true, false]) {
    const write = vi.fn(() => {
      if (sync) throw new Error("broken");
      return Promise.reject(new Error("broken"));
    });
    const failed = vi.fn();
    const writer = new OrderedLspWriter(write, failed);
    writer.send("open");
    writer.send("change");
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
  }
});
