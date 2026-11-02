import { expect, it, vi } from "vitest";
import { beginComposerWork, cancelComposerWork } from "./composerWork";
it("cancellation cleans up once and cannot reach a later submission", () => {
  const old = beginComposerWork("chat"),
    cleanup = vi.fn();
  old.onFinish(cleanup);
  cancelComposerWork("chat");
  expect(old.signal.aborted).toBe(true);
  expect(cleanup).toHaveBeenCalledOnce();
  const next = beginComposerWork("chat");
  old.cancel();
  old.finish();
  expect(next.signal.aborted).toBe(false);
  next.finish();
  cancelComposerWork("chat");
  expect(next.signal.aborted).toBe(false);
  expect(cleanup).toHaveBeenCalledOnce();
});
it("disposes a subscription registered after cancellation immediately", () => {
  const work = beginComposerWork("late");
  work.cancel();
  const unsubscribe = vi.fn();
  work.onFinish(unsubscribe);
  expect(unsubscribe).toHaveBeenCalledOnce();
});
