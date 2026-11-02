import { expect, it, vi } from "vitest";
import { createWatchHealthMonitor, type WatchHealth } from "./watchHealthState";
function setup() {
  let changed!: (health: WatchHealth) => void;
  const off = vi.fn();
  const io = {
    listen: vi.fn(async (cb: (h: WatchHealth) => void): Promise<() => void> => {
      changed = cb;
      return off;
    }),
    read: vi.fn(
      async (): Promise<WatchHealth> => ({ revision: 0, error: null }),
    ),
    retry: vi.fn(
      async (): Promise<WatchHealth> => ({ revision: 2, error: null }),
    ),
    present: vi.fn(),
  };
  return {
    io,
    off,
    send: (h: WatchHealth) => changed(h),
    monitor: createWatchHealthMonitor(io),
  };
}
it("shares one subscription, rejects stale snapshots, and notifies existing consumers of failure and recovery", async () => {
  const t = setup();
  let finish!: (h: WatchHealth) => void;
  t.io.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const one = vi.fn(),
    two = vi.fn(),
    retry = vi.fn();
  const a = t.monitor.subscribe(one, retry),
    b = t.monitor.subscribe(two);
  const ready = a.ready;
  await vi.waitFor(() => expect(finish).toBeDefined());
  t.send({ revision: 1, error: "backend stopped" });
  finish({ revision: 0, error: null });
  await ready;
  await b.ready;
  expect(a.current().error).toBe("backend stopped");
  expect(two).toHaveBeenCalledWith({ revision: 1, error: "backend stopped" });
  await t.monitor.retry();
  expect(a.current().error).toBeNull();
  expect(retry).toHaveBeenCalledOnce();
  expect(one).toHaveBeenLastCalledWith({ revision: 2, error: null });
  a.dispose();
  expect(t.off).not.toHaveBeenCalled();
  b.dispose();
  expect(t.off).toHaveBeenCalledOnce();
});
it("recovers a failed listener setup and retries failed acquisitions", async () => {
  const t = setup();
  t.io.listen.mockRejectedValueOnce(new Error("IPC unavailable"));
  const retried = vi.fn();
  const owner = t.monitor.subscribe(vi.fn(), retried);
  await expect(owner.ready).rejects.toThrow("IPC unavailable");
  expect(owner.current().error).toContain("IPC unavailable");
  await t.monitor.retry();
  await owner.ready;
  expect(retried).toHaveBeenCalledOnce();
  expect(owner.current().error).toBeNull();
  owner.dispose();
});
it("does not install a late listener or start retry work after the last consumer leaves", async () => {
  const t = setup();
  let finish!: (off: () => void) => void;
  t.io.listen.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const a = t.monitor.subscribe();
  const pending = a.ready;
  a.dispose();
  finish(t.off);
  await pending;
  expect(t.off).toHaveBeenCalledOnce();
  expect(t.io.read).not.toHaveBeenCalled();
});
it("keeps a read failure visible until a fresh snapshot resolves", async () => {
  const t = setup();
  const owner = t.monitor.subscribe();
  await owner.ready;
  t.io.read.mockRejectedValueOnce(new Error("snapshot failed"));
  await expect(owner.refresh()).rejects.toThrow("snapshot failed");
  expect(owner.current().error).toContain("snapshot failed");
  await owner.refresh();
  expect(owner.current().error).toBeNull();
  owner.dispose();
});
it("Retry from a disposed view does not leak a health listener", async () => {
  const t = setup();
  await t.monitor.retry();
  expect(t.io.retry).toHaveBeenCalledOnce();
  expect(t.io.listen).not.toHaveBeenCalled();
});
