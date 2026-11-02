import { afterEach, beforeEach, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as { onmessage: (buffer: ArrayBuffer) => void }[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: bridge.invoke,
  Channel: class {
    onmessage = (_buffer: ArrayBuffer) => {};
    constructor() {
      bridge.channels.push(this);
    }
    toJSON() {
      return "__CHANNEL__:1";
    }
  },
}));

import { requestRemoteImage } from "@/modules/markdown/remoteImageRequest";
import { proxyFetch } from "./proxyFetch";

let page: EventTarget & { __OARLOCK_NETWORK_PAGE__?: string };
beforeEach(() => {
  page = new EventTarget();
  vi.stubGlobal("window", page);
  bridge.invoke.mockReset().mockResolvedValue(undefined);
  bridge.channels.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

it("cancels an upload aborted just after an already-ready page generation is read", async () => {
  page.__OARLOCK_NETWORK_PAGE__ = "ready";
  const owner = new AbortController();
  const cancel = vi.fn();
  const pending = proxyFetch("https://example.test", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({ cancel }),
    signal: owner.signal,
    duplex: "half",
  } as RequestInit);
  const rejected = expect(pending).rejects.toThrow("stopped");
  owner.abort(new Error("stopped"));
  await rejected;
  expect(cancel).toHaveBeenCalledWith(owner.signal.reason);
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("cancels an upload whose signal was already aborted", async () => {
  const owner = new AbortController();
  owner.abort(new Error("already stopped"));
  const cancel = vi.fn();
  const pending = proxyFetch("https://example.test", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({ cancel }),
    signal: owner.signal,
    duplex: "half",
  } as RequestInit);
  await expect(pending).rejects.toThrow("already stopped");
  expect(cancel).toHaveBeenCalledWith(owner.signal.reason);
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("cancels upload preparation while awaiting native page delivery without sending IPC", async () => {
  const owner = new AbortController();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const pending = proxyFetch("https://example.test", {
    method: "POST",
    body,
    signal: owner.signal,
    duplex: "half",
  } as RequestInit);
  const rejected = expect(pending).rejects.toThrow("stopped");
  await Promise.resolve();
  owner.abort(new Error("stopped"));
  await rejected;
  expect(cancel).toHaveBeenCalledWith(owner.signal.reason);
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("waits for delivery, then binds delayed cancellation retries to the original generation", async () => {
  let acknowledge!: () => void;
  bridge.invoke.mockImplementation((command: string) =>
    command === "ai_http_stream"
      ? new Promise<void>((resolve) => {
          acknowledge = resolve;
        })
      : Promise.resolve(),
  );
  const owner = new AbortController();
  const pending = proxyFetch("https://example.test", { signal: owner.signal });
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await Promise.resolve();
  expect(bridge.invoke).not.toHaveBeenCalled();
  page.__OARLOCK_NETWORK_PAGE__ = "original";
  page.dispatchEvent(new Event("oarlock:network-page"));
  await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalled());
  const [, , options] = bridge.invoke.mock.calls[0];
  expect(
    JSON.parse(options.headers["x-oarlock-ai-request"]).pageGeneration,
  ).toBe("original");
  page.__OARLOCK_NETWORK_PAGE__ = "replacement";
  owner.abort();
  await rejected;
  acknowledge();
  await vi.waitFor(() =>
    expect(
      bridge.invoke.mock.calls.filter(([name]) => name === "ai_http_cancel"),
    ).toHaveLength(2),
  );
  for (const [, args] of bridge.invoke.mock.calls.filter(
    ([name]) => name === "ai_http_cancel",
  ))
    expect(args.pageGeneration).toBe("original");
});

it("an image released during page initialization never starts a later download", async () => {
  const owner = new AbortController();
  const pending = requestRemoteImage(
    "https://example.test/image",
    owner.signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  owner.abort();
  await rejected;
  page.__OARLOCK_NETWORK_PAGE__ = "late";
  page.dispatchEvent(new Event("oarlock:network-page"));
  await Promise.resolve();
  expect(bridge.invoke).not.toHaveBeenCalled();
});
