import { expect, it, vi, beforeEach } from "vitest";
const fake = vi.hoisted(() => ({
  invoke: vi.fn(),
  globals: vi.fn(),
  records: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("./configStore", () => ({
  loadServers: fake.globals,
  loadProjectRecords: fake.records,
}));
import { captureRunServers } from "./runServers";
const project = (key: string, active: boolean, id: string) => ({
  project: { key, root: key, workspace: { kind: "local" } },
  active,
  servers: [
    {
      id,
      name: key,
      transport: {
        type: "stdio",
        command: "server",
        args: [],
        env: [],
        cwd: null,
      },
      entryHash: "hash",
      problem: null,
    },
  ],
});
const a = "prj-aaaaaaaaaaaa-aaaaaaaaaaaa",
  b = "prj-bbbbbbbbbbbb-bbbbbbbbbbbb";
beforeEach(() => {
  vi.clearAllMocks();
  fake.globals.mockResolvedValue([{ id: "global" }]);
  fake.records.mockResolvedValue({});
  fake.invoke.mockImplementation(async (command: string) =>
    command === "mcp_run_open"
      ? {
          lease: 7,
          projectKey: "/a",
          projects: [project("/a", false, a), project("/b", true, b)],
        }
      : undefined,
  );
});
it("keeps the submitted project while excluding another space's tools", async () => {
  const run = await captureRunServers("/a", { kind: "local" });
  expect(fake.invoke).toHaveBeenCalledWith("mcp_run_open", {
    root: "/a",
    workspace: { kind: "local" },
  });
  expect(run.offeredIds).toEqual(new Set(["global", a]));
  expect(run.servers.find((s) => s.id === a)?.retainedOnly).toBe(true);
  await run.release();
  await run.release();
  expect(
    fake.invoke.mock.calls.filter(([command]) => command === "mcp_run_release"),
  ).toEqual([["mcp_run_release", { lease: 7 }]]);
});
it("releases a late lease after another part of preparation fails", async () => {
  let opened!: (value: unknown) => void;
  fake.invoke.mockImplementation((command: string) =>
    command === "mcp_run_open"
      ? new Promise((resolve) => {
          opened = resolve;
        })
      : Promise.resolve(),
  );
  fake.records.mockRejectedValueOnce(new Error("store unavailable"));
  const pending = captureRunServers("/a", { kind: "local" });
  const check = expect(pending).rejects.toThrow("store unavailable");
  opened({ lease: 8, projectKey: "/a", projects: [] });
  await check;
  expect(fake.invoke).toHaveBeenCalledWith("mcp_run_release", { lease: 8 });
});

it("retries a failed native release instead of permanently abandoning its lease", async () => {
  const run = await captureRunServers("/a", { kind: "local" });
  fake.invoke.mockRejectedValueOnce(new Error("temporary IPC failure"));
  const first = run.release();
  expect(run.release()).toBe(first);
  await expect(first).rejects.toThrow("temporary IPC failure");
  await run.release();
  expect(
    fake.invoke.mock.calls.filter(([command]) => command === "mcp_run_release"),
  ).toHaveLength(2);
});

it("keeps an early lease reachable by Stop when setup and cleanup both fail", async () => {
  const { holdMcpRun, hasMcpRunLeases, releaseChatMcpRuns } = await import(
    "@/modules/ai/lib/mcpRunLeases"
  );
  fake.records.mockRejectedValueOnce(new Error("store unavailable"));
  fake.invoke.mockImplementation(async (command: string) => {
    if (command === "mcp_run_open")
      return { lease: 9, projectKey: "/a", projects: [] };
    if (command === "mcp_run_release") throw new Error("IPC failed");
  });
  await expect(
    captureRunServers(
      "/a",
      { kind: "local" },
      (release) => holdMcpRun("failed-setup", release).release,
    ),
  ).rejects.toThrow("store unavailable");
  expect(hasMcpRunLeases("failed-setup")).toBe(true);
  fake.invoke.mockResolvedValue(undefined);
  await releaseChatMcpRuns("failed-setup");
  expect(hasMcpRunLeases("failed-setup")).toBe(false);
  expect(fake.invoke).toHaveBeenLastCalledWith("mcp_run_release", { lease: 9 });
});
