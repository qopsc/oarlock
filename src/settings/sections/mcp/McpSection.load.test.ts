import { expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  cells: [] as unknown[],
  index: 0,
  effects: [] as (() => unknown)[],
  records: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<object>()),
  useState: (initial: unknown) => {
    const i = fake.index++;
    if (!(i in fake.cells)) fake.cells[i] = initial;
    return [
      fake.cells[i],
      (v: unknown) => {
        fake.cells[i] = typeof v === "function" ? v(fake.cells[i]) : v;
      },
    ];
  },
  useEffect: (fn: () => unknown) => {
    fake.effects.push(fn);
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: { getState: () => ({}) },
}));
vi.mock("@/modules/mcp/lib/configStore", () => ({
  loadServers: async () => [],
  loadProjectRecords: fake.records,
  listProjectServers: async () => [
    { root: "/project", servers: [{ name: "remote" }] },
  ],
  loadKnownTools: async () => ({}),
  onMcpChanged: async () => () => {},
}));
import { useMcpState } from "./McpSection";
function read() {
  fake.index = 0;
  fake.effects = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: React hooks are mocked to control async completion.
  return useMcpState();
}
it("does not expose project defaults when policy loading fails, and Retry loads both together", async () => {
  fake.records.mockRejectedValueOnce(new Error("MCP file damaged"));
  read();
  const cleanups = fake.effects.map((fn) => fn());
  await new Promise((r) => setTimeout(r, 0));
  const failed = read();
  expect(failed.loadError).toContain("file damaged");
  expect(failed.projects).toEqual([]);
  expect(failed.servers).toBeNull();
  failed.retry();
  for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
  fake.records.mockResolvedValue({});
  read();
  fake.effects.forEach((fn) => {
    fn();
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(read().loadError).toBeNull();
  expect(read().projects).toHaveLength(1);
  expect(read().servers).toEqual([]);
});
