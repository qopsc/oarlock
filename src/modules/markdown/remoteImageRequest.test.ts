import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/networkPage", () => ({ networkPage: async () => "test-page" }));

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
  },
}));

import { requestRemoteImage } from "./remoteImageRequest";

beforeEach(() => {
  bridge.channels = [];
  bridge.invoke.mockReset().mockResolvedValue(undefined);
});
const cancellations = () =>
  bridge.invoke.mock.calls.filter(
    ([command]) => command === "markdown_remote_image_cancel",
  );

it("repeats an early cancellation once native registration is acknowledged", async () => {
  let acknowledge!: () => void;
  bridge.invoke.mockImplementation((command: string) =>
    command === "markdown_remote_image"
      ? new Promise<void>((done) => {
          acknowledge = done;
        })
      : Promise.resolve(),
  );
  const owner = new AbortController();
  const pending = requestRemoteImage("https://x/a", owner.signal);
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await Promise.resolve();
  const late = bridge.channels[0].onmessage;
  owner.abort();
  await rejected;
  expect(cancellations()).toHaveLength(1);
  expect(cancellations()[0][1].pageGeneration).toBe("test-page");
  expect(bridge.invoke.mock.calls[0][1].pageGeneration).toBe("test-page");
  acknowledge();
  await Promise.resolve();
  expect(cancellations()).toHaveLength(2);
  expect(cancellations()[1][1]).toEqual(cancellations()[0][1]);
  late(new Uint8Array([0, 1, 120, 9]).buffer);
});

it("does not register an already cancelled request", async () => {
  const owner = new AbortController();
  owner.abort();
  await expect(
    requestRemoteImage("https://x/a", owner.signal),
  ).rejects.toThrow();
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("returns one binary result and removes abort ownership after completion", async () => {
  const owner = new AbortController();
  const pending = requestRemoteImage("https://x/a", owner.signal);
  await Promise.resolve();
  bridge.channels[0].onmessage(new Uint8Array([0, 1, 120, 9]).buffer);
  expect(await pending).toEqual(new Uint8Array([1, 120, 9]));
  owner.abort();
  expect(cancellations()).toHaveLength(0);
});

it("surfaces native failures and rejects malformed packets", async () => {
  const owner = new AbortController();
  const first = requestRemoteImage("https://x/a", owner.signal);
  const failure = expect(first).rejects.toThrow("HTTP 404");
  await Promise.resolve();
  bridge.channels[0].onmessage(
    new Uint8Array([1, ...new TextEncoder().encode("HTTP 404")]).buffer,
  );
  await failure;
  const second = requestRemoteImage("https://x/b", owner.signal);
  const malformed = expect(second).rejects.toThrow(
    "Invalid native image response",
  );
  await Promise.resolve();
  bridge.channels[1].onmessage(new Uint8Array([8]).buffer);
  await malformed;
  expect(cancellations().length).toBeGreaterThan(0);
});

it("reports rejected native admission and leaves no abort listener behind", async () => {
  bridge.invoke.mockRejectedValueOnce("duplicate request");
  const owner = new AbortController();
  await expect(requestRemoteImage("https://x/a", owner.signal)).rejects.toThrow(
    "duplicate request",
  );
  owner.abort();
  expect(cancellations()).toHaveLength(0);
});
