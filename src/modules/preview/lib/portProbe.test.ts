import { afterEach, expect, it, vi } from "vitest";
import { PortProbe, probeUrl } from "./portProbe";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("bounds each probe by the existing 900ms deadline without retaining a timer", () => {
  vi.useFakeTimers();
  const owner = new PortProbe(),
    request = owner.start();
  vi.advanceTimersByTime(900);
  expect(request.signal.aborted).toBe(true);
  expect(request.current()).toBe(true);
  request.finish();
  expect(request.current()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("old completion cannot cancel a newer probe", () => {
  vi.useFakeTimers();
  const owner = new PortProbe(),
    old = owner.start(),
    next = owner.start();
  old.finish();
  expect(old.signal.aborted).toBe(true);
  expect(next.signal.aborted).toBe(false);
  owner.cancel();
  expect(vi.getTimerCount()).toBe(0);
});
it("discards page bodies when only reachability is needed", async () => {
  const cancel = vi.fn(async () => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ body: { cancel } })),
  );
  expect(
    await probeUrl("http://localhost:3000", new AbortController().signal),
  ).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
});
