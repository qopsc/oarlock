import { beforeEach, expect, it, vi } from "vitest";
import type { McpServerConfig } from "@/modules/mcp/lib/config";

const fake = vi.hoisted(() => ({ invoke: vi.fn(), page: vi.fn() }));
vi.mock("@/lib/networkPage", () => ({ networkPage: fake.page }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: fake.invoke,
  Channel: class {
    onmessage = (_reply: unknown) => {};
  },
}));
import { requestMetadataProbe } from "./metadataProbe";
const server: McpServerConfig = {
  id: "a",
  name: "A",
  source: "settings",
  enabled: true,
  trusted: false,
  tools: {},
  secretsRevision: 3,
  transport: { type: "http", url: "https://example.test/mcp", headers: [] },
};
beforeEach(() => {
  fake.invoke.mockReset().mockResolvedValue(undefined);
  fake.page.mockReset().mockResolvedValue("page-one");
});

it("carries configuration revision and retries an overtaken cancellation with exact ownership", async () => {
  let admitted!: () => void;
  fake.invoke.mockImplementation((command) =>
    command === "mcp_oauth_probe"
      ? new Promise<void>((resolve) => {
          admitted = resolve;
        })
      : Promise.resolve(),
  );
  const controller = new AbortController();
  const pending = requestMetadataProbe(server, controller.signal, "/bin/zsh");
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await Promise.resolve();
  const args = fake.invoke.mock.calls[0][1];
  expect(args.input).toEqual({
    serverId: "a",
    url: "https://example.test/mcp",
    revision: 3,
    shell: "/bin/zsh",
  });
  controller.abort();
  await rejected;
  admitted();
  await Promise.resolve();
  expect(fake.invoke.mock.calls.slice(1)).toEqual(
    [1, 2].map(() => [
      "mcp_oauth_probe_cancel",
      { requestId: args.requestId, pageGeneration: "page-one" },
    ]),
  );
  args.onEvent.onmessage({ Err: "late error" });
});

it("does not send queued work after cancellation while page initialization waits", async () => {
  let ready!: (page: string) => void;
  fake.page.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        ready = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = requestMetadataProbe(server, controller.signal, null);
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  ready("new-page");
  await rejected;
  expect(fake.invoke).not.toHaveBeenCalled();
});

it("propagates native discovery errors and releases the abort listener on completion", async () => {
  const controller = new AbortController();
  const pending = requestMetadataProbe(server, controller.signal, null);
  const rejected = expect(pending).rejects.toThrow("HTTP 503");
  await Promise.resolve();
  fake.invoke.mock.calls[0][1].onEvent.onmessage({ Err: "HTTP 503" });
  await rejected;
  controller.abort();
  expect(fake.invoke).toHaveBeenCalledTimes(1);
});
