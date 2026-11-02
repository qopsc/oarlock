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
import { captureRunServers, clearRunProject } from "./runServers";
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
const scope = { runId: "0123456789abcdef0123456789abcdef", ready: Promise.resolve() };
beforeEach(() => {
  vi.clearAllMocks();
  fake.globals.mockResolvedValue([{ id: "global" }]);
  fake.records.mockResolvedValue({});
  fake.invoke.mockImplementation(async (command: string) =>
    command === "ai_run_mcp_open"
      ? {
          projectKey: "/a",
          projects: [project("/a", false, a), project("/b", true, b)],
        }
      : undefined,
  );
});
it("keeps the submitted project while excluding another space's tools", async () => {
  const run = await captureRunServers("/a", { kind: "local" }, scope);
  expect(fake.invoke).toHaveBeenCalledWith("ai_run_mcp_open", {
    runId: scope.runId,
    root: "/a",
    workspace: { kind: "local" },
  });
  expect(run.offeredIds).toEqual(new Set(["global", a]));
  expect(run.servers.find((s) => s.id === a)?.retainedOnly).toBe(true);
});

it("waits for the native run record before opening a project", async () => {
  let ready!: () => void;
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const pending = captureRunServers("/a", { kind: "local" }, { ...scope, ready: waiting });
  await Promise.resolve();
  expect(fake.invoke).not.toHaveBeenCalled();
  ready();
  await pending;
  expect(fake.invoke).toHaveBeenCalledTimes(1);
});

it("a failed project open costs the run its project servers but not the run", async () => {
  fake.invoke.mockRejectedValue(new Error("this run has ended"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const run = await captureRunServers("/a", { kind: "local" }, scope);
  expect(run.offeredIds).toEqual(new Set(["global"]));
  warn.mockRestore();
});

it("clears the run's project when it ends up with no MCP tools", async () => {
  await clearRunProject(scope, { kind: "local" });
  expect(fake.invoke).toHaveBeenCalledWith("ai_run_mcp_open", {
    runId: scope.runId,
    root: null,
    workspace: { kind: "local" },
  });
});
