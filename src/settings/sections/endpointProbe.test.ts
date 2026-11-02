import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), page: vi.fn() }));
vi.mock("@/lib/networkPage", () => ({ networkPage: fake.page }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: fake.invoke,
  Channel: class {
    onmessage = (_reply: unknown) => {};
  },
}));
import { requestEndpointProbe } from "./endpointProbe";

function request() {
  return fake.invoke.mock.calls.find(
    ([command]) => command === "lm_ping",
  )?.[1] as {
    baseUrl: string;
    requestId: string;
    pageGeneration: string;
    onEvent: { onmessage: (reply: { Ok: number } | { Err: string }) => void };
  };
}
beforeEach(() => {
  fake.invoke.mockReset().mockResolvedValue(undefined);
  fake.page.mockReset().mockResolvedValue("page-one");
});

it("carries exact ownership and treats completion independently of registration", async () => {
  fake.invoke.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = requestEndpointProbe(
    "https://example.test",
    controller.signal,
  );
  await Promise.resolve();
  expect(request().baseUrl).toBe("https://example.test");
  expect(request().pageGeneration).toBe("page-one");
  expect(request().requestId).toBeTruthy();
  request().onEvent.onmessage({ Ok: 401 });
  expect(await pending).toBe(401);
  controller.abort();
  expect(fake.invoke).toHaveBeenCalledTimes(1);
});

it("repeats cancellation after delayed admission with the original identity", async () => {
  let admitted!: () => void;
  fake.invoke.mockImplementation((command: string) =>
    command === "lm_ping"
      ? new Promise<void>((resolve) => {
          admitted = resolve;
        })
      : Promise.resolve(),
  );
  const controller = new AbortController();
  const pending = requestEndpointProbe(
    "https://example.test",
    controller.signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await Promise.resolve();
  const { requestId, pageGeneration } = request();
  controller.abort();
  await rejected;
  admitted();
  await Promise.resolve();
  const cancellations = fake.invoke.mock.calls.filter(
    ([command]) => command === "lm_ping_cancel",
  );
  expect(cancellations).toEqual([
    ["lm_ping_cancel", { requestId, pageGeneration }],
    ["lm_ping_cancel", { requestId, pageGeneration }],
  ]);
  request().onEvent.onmessage({ Ok: 200 });
});

it("does not admit a request cancelled while page ownership loads", async () => {
  let loaded!: (page: string) => void;
  fake.page.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        loaded = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = requestEndpointProbe(
    "https://example.test",
    controller.signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  loaded("page-two");
  await rejected;
  expect(fake.invoke).not.toHaveBeenCalled();
});

it("surfaces admission errors and native request failures", async () => {
  fake.invoke.mockRejectedValueOnce(
    "Connection probes are busy (8 active); try again",
  );
  await expect(
    requestEndpointProbe("https://example.test", new AbortController().signal),
  ).rejects.toContain("8 active");
  const pending = requestEndpointProbe(
    "https://example.test",
    new AbortController().signal,
  );
  await Promise.resolve();
  const last = fake.invoke.mock.calls[
    fake.invoke.mock.calls.length - 1
  ]?.[1] as ReturnType<typeof request>;
  last.onEvent.onmessage({ Err: "Connection probe timed out after 5 seconds" });
  await expect(pending).rejects.toThrow("timed out");
});
