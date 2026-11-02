import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLiveDiff } from "./liveDiff";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function setup() {
  const read = vi.fn<() => Promise<string>>();
  const loading = vi.fn(),
    loaded = vi.fn(),
    failed = vi.fn();
  return {
    read,
    loading,
    loaded,
    failed,
    controller: createLiveDiff({ read, loading, loaded, failed }),
  };
}
it("discards a superseded read and coalesces bursts without parallel native reads", async () => {
  const t = setup();
  let finish!: (v: string) => void;
  t.read
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue("new");
  t.controller.start();
  for (let i = 0; i < 30; i++) t.controller.invalidate();
  await vi.advanceTimersByTimeAsync(100);
  expect(t.read).toHaveBeenCalledTimes(1);
  finish("old");
  await vi.advanceTimersByTimeAsync(40);
  expect(t.loaded.mock.calls).toEqual([["new"]]);
  expect(t.read).toHaveBeenCalledTimes(2);
});
it("shows refresh errors and can recover on another invalidation", async () => {
  const t = setup();
  t.read
    .mockRejectedValueOnce(new Error("read failed"))
    .mockResolvedValue("fresh");
  t.controller.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.failed).toHaveBeenCalledOnce();
  t.controller.invalidate();
  await vi.advanceTimersByTimeAsync(40);
  expect(t.loaded).toHaveBeenCalledWith("fresh");
});
it("ignores late reads and queued refreshes after disposal", async () => {
  const t = setup();
  let finish!: (v: string) => void;
  t.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  t.controller.start();
  t.controller.invalidate();
  t.controller.dispose();
  finish("late");
  await vi.advanceTimersByTimeAsync(100);
  expect(t.loaded).not.toHaveBeenCalled();
  expect(t.read).toHaveBeenCalledTimes(1);
});
it("does not let a read hide a watcher failure", async () => {
  const t = setup();
  let finish!: (v: string) => void;
  t.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  t.controller.start();
  t.controller.fail("watch failed");
  finish("late");
  await vi.advanceTimersByTimeAsync(100);
  expect(t.loaded).not.toHaveBeenCalled();
  expect(t.failed).toHaveBeenCalledWith("watch failed");
});
it("recovers from degraded coverage without overlapping a superseded read", async () => {
  const t = setup();
  let finish!: (v: string) => void;
  t.read
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue("fresh");
  t.controller.start();
  t.controller.fail("notifications unavailable");
  t.controller.start();
  expect(t.read).toHaveBeenCalledTimes(1);
  finish("old");
  await vi.advanceTimersByTimeAsync(40);
  expect(t.loaded.mock.calls).toEqual([["fresh"]]);
  t.controller.invalidate();
  await vi.advanceTimersByTimeAsync(40);
  expect(t.read).toHaveBeenCalledTimes(3);
});
