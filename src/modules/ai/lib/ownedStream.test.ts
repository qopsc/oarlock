import { expect, it, vi } from "vitest";
import { ownedStream } from "./ownedStream";
it("releases once when a stream finishes", async () => {
  const release = vi.fn(async () => {});
  const stream = ownedStream(
    new ReadableStream({
      start(c) {
        c.enqueue("result");
        c.close();
      },
    }),
    release,
  );
  const reader = stream.getReader();
  expect((await reader.read()).value).toBe("result");
  expect((await reader.read()).done).toBe(true);
  expect(release).toHaveBeenCalledOnce();
});
it("releases on failure and consumer cancellation", async () => {
  const failed = vi.fn(async () => {});
  const stream = ownedStream(
    new ReadableStream({
      start(c) {
        c.error(new Error("failed"));
      },
    }),
    failed,
  );
  await expect(stream.getReader().read()).rejects.toThrow("failed");
  expect(failed).toHaveBeenCalledOnce();
  const release = vi.fn(async () => {}),
    cancelled = vi.fn();
  await ownedStream(new ReadableStream({ cancel: cancelled }), release).cancel(
    "stop",
  );
  expect(cancelled).toHaveBeenCalledWith("stop");
  expect(release).toHaveBeenCalledOnce();
});
it("Stop releases a stalled run once, even if cancellation follows", async () => {
  const release = vi.fn(async () => {}),
    controller = new AbortController();
  const stream = ownedStream(new ReadableStream(), release, controller.signal);
  controller.abort();
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  await stream.cancel();
  expect(release).toHaveBeenCalledOnce();
});
