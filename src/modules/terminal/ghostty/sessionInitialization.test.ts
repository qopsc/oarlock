import { describe, expect, it, vi } from "vitest";
import {
  initializeSessionGeneration,
  waitForSessionClose,
  type SessionInitializationState,
} from "@/modules/terminal/ghostty/sessionInitialization";

describe("Ghostty startup failure handling", () => {
  it("reports a failed attempt once while preserving session ownership", async () => {
    const state: SessionInitializationState = {
      generation: 0,
      disposed: false,
      initializing: null,
    };
    const failure = new Error("shell unavailable");
    const start = vi.fn().mockRejectedValue(failure);
    const report = vi.fn();
    const first = initializeSessionGeneration(state, start, report);
    expect(initializeSessionGeneration(state, start, report)).toBe(first);
    await first;
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    expect(state.disposed).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it.each(["closed", "replaced"])(
    "ignores a late failure for a %s generation",
    async (change) => {
      const state: SessionInitializationState = {
        generation: 0,
        disposed: false,
        initializing: null,
      };
      let reject: (error: Error) => void = () => {};
      const report = vi.fn();
      const initializing = initializeSessionGeneration(
        state,
        () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          }),
        report,
      );
      if (change === "closed") state.disposed = true;
      else state.generation += 1;
      reject(new Error("late failure"));
      await initializing;
      expect(report).not.toHaveBeenCalled();
    },
  );
});

describe("terminal restart ownership", () => {
  it("does not let an older close clear a newer restart", async () => {
    const state: SessionInitializationState = { generation: 1, disposed: false, initializing: null };
    let finish!: () => void;
    const close = new Promise<void>((resolve) => { finish = resolve; });
    const old = waitForSessionClose(state, 1, () => close, () => true);
    state.generation = 2;
    expect(await waitForSessionClose(state, 2, async () => {}, () => true)).toBe(true);
    finish();
    expect(await old).toBe(false);
  });

  it.each(["disposed", "replaced"])("ignores a close failure after the session was %s", async (change) => {
    const state: SessionInitializationState = { generation: 1, disposed: false, initializing: null };
    let reject!: (error: Error) => void;
    let owned = true;
    const close = new Promise<void>((_resolve, fail) => { reject = fail; });
    const pending = waitForSessionClose(state, 1, () => close, () => owned);
    if (change === "disposed") state.disposed = true; else owned = false;
    reject(new Error("late close failure"));
    expect(await pending).toBe(false);
  });

  it("reports a close failure for the current restart", async () => {
    const state: SessionInitializationState = { generation: 1, disposed: false, initializing: null };
    await expect(waitForSessionClose(state, 1, async () => { throw new Error("close failed"); }, () => true))
      .rejects.toThrow("close failed");
  });
});
