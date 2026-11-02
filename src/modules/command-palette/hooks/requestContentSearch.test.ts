const args = {
  pattern: "needle",
  root: "/repo",
  workspace: { kind: "local" as const },
  channel: "sidebar" as const,
  maxResults: 80,
};
const reply = { hits: [], truncated: false, cancelled: false };
import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), page: vi.fn() }));
vi.mock("@/lib/networkPage", () => ({ networkPage: fake.page }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: fake.invoke,
  Channel: class {
    onmessage = (_reply: unknown) => {};
  },
}));
import { requestContentSearch } from "./requestContentSearch";

function request() {
  return fake.invoke.mock.calls.find(
    ([command]) => command === "fs_grep_interactive",
  )?.[1] as {
    root: string;
    requestId: string;
    pageGeneration: string;
    onEvent: {
      onmessage: (value: { Ok: typeof reply } | { Err: string }) => void;
    };
  };
}
beforeEach(() => {
  fake.invoke.mockReset().mockResolvedValue(undefined);
  fake.page.mockReset().mockResolvedValue("page-one");
});

it("carries exact ownership and treats completion independently of registration", async () => {
  fake.invoke.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = requestContentSearch(args, controller.signal);
  await Promise.resolve();
  expect(request().root).toBe("/repo");
  expect(request().pageGeneration).toBe("page-one");
  expect(request().requestId).toBeTruthy();
  request().onEvent.onmessage({ Ok: reply });
  expect(await pending).toEqual(reply);
  controller.abort();
  expect(fake.invoke).toHaveBeenCalledTimes(1);
});

it("repeats cancellation after delayed admission with the original identity", async () => {
  let admitted = () => {};
  fake.invoke.mockImplementation((command: string) =>
    command === "fs_grep_interactive"
      ? new Promise<void>((resolve) => {
          admitted = resolve;
        })
      : Promise.resolve(),
  );
  const controller = new AbortController();
  const pending = requestContentSearch(args, controller.signal);
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
    ([command]) => command === "fs_grep_cancel",
  );
  expect(cancellations).toEqual([
    ["fs_grep_cancel", { requestId, pageGeneration }],
    ["fs_grep_cancel", { requestId, pageGeneration }],
  ]);
  request().onEvent.onmessage({ Ok: reply });
});

it("does not admit a request cancelled while page ownership loads", async () => {
  let loaded = (_page: string) => {};
  fake.page.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        loaded = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = requestContentSearch(args, controller.signal);
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
    requestContentSearch(args, new AbortController().signal),
  ).rejects.toContain("8 active");
  const pending = requestContentSearch(args, new AbortController().signal);
  await Promise.resolve();
  const last = fake.invoke.mock.calls[
    fake.invoke.mock.calls.length - 1
  ]?.[1] as ReturnType<typeof request>;
  last.onEvent.onmessage({ Err: "Connection probe timed out after 5 seconds" });
  await expect(pending).rejects.toThrow("timed out");
});
