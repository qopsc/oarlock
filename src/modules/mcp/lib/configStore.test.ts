import { expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  listen: vi.fn(),
  invoke: vi.fn(
    async (_command: string, _args?: unknown): Promise<unknown> => undefined,
  ),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: fake.listen }));
import {
  loadServers,
  loadProjectRecords,
  loadKnownTools,
  onMcpChanged,
  saveProjectRecord,
  updateServer,
} from "./configStore";
import type { McpServerConfig } from "./config";

it("submits independent project edits without replacing shared snapshots", async () => {
  fake.invoke.mockClear();
  const base = { entryHash: "hash", enabled: true, trusted: false, tools: {} };
  await Promise.all([
    saveProjectRecord("prj-a", base, { ...base, enabled: false }),
    saveProjectRecord("prj-b", base, { ...base, tools: { write: "deny" } }),
  ]);
  expect(fake.invoke.mock.calls).toEqual([
    [
      "mcp_settings_mutate",
      {
        changes: [
          {
            kind: "project",
            id: "prj-a",
            entryHash: "hash",
            patches: [{ path: ["enabled"], value: false }],
          },
        ],
      },
    ],
    [
      "mcp_settings_mutate",
      {
        changes: [
          {
            kind: "project",
            id: "prj-b",
            entryHash: "hash",
            patches: [{ path: ["tools", "write"], value: "deny" }],
          },
        ],
      },
    ],
  ]);
});

it("saving a stale server editor does not resend unchanged permission fields", async () => {
  fake.invoke.mockClear();
  const before: McpServerConfig = {
    id: "a",
    name: "A",
    source: "settings",
    enabled: true,
    trusted: true,
    tools: {},
    secretsRevision: 0,
    transport: {
      type: "stdio",
      command: "server",
      args: [],
      env: [],
      cwd: null,
    },
  };
  await updateServer(before, { ...before, name: "New name" }, [], true);
  expect(fake.invoke).toHaveBeenCalledWith("mcp_settings_mutate", {
    changes: [
      {
        kind: "update",
        id: "a",
        patches: [{ path: ["name"], value: "New name" }],
        secrets: [],
        expected: { revision: 0, transport: before.transport },
      },
    ],
  });
});

it("cleans up every listener, including late registrations, when one fails", async () => {
  const early = vi.fn(),
    late = vi.fn();
  let finish!: (off: () => void) => void;
  fake.listen
    .mockResolvedValueOnce(early)
    .mockRejectedValueOnce(new Error("listen failed"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(early);
  const pending = onMcpChanged(vi.fn());
  const check = expect(pending).rejects.toThrow("listen failed");
  finish(late);
  await check;
  expect(early).toHaveBeenCalledTimes(2);
  expect(late).toHaveBeenCalledOnce();
});

it("reads snapshots through the native owner and propagates damaged-file errors", async () => {
  fake.invoke.mockClear();
  fake.invoke
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ "tools:a": [{ name: "read" }] });
  expect(await loadServers()).toEqual([]);
  expect(await loadProjectRecords()).toEqual({});
  expect(await loadKnownTools()).toMatchObject({ a: [{ name: "read" }] });
  expect(fake.invoke.mock.calls.map(([name, args]) => [name, args])).toEqual([
    ["mcp_settings_snapshot", { key: "servers" }],
    ["mcp_settings_snapshot", { key: "projectServers" }],
    ["mcp_settings_snapshot", { key: "tools" }],
  ]);
  fake.invoke.mockRejectedValueOnce(
    new Error("Damaged MCP settings; file preserved"),
  );
  await expect(loadServers()).rejects.toThrow("file preserved");
});
