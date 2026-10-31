import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
import { applyTaskChange, type SubagentTask } from "./subagentTasks";
it("ignores stale updates and applies retention removals after upserting", () => {
  const task = { id: "a", status: "completed", startedAt: 1 } as SubagentTask;
  const snapshot = { revision: 5, tasks: [task] };
  expect(
    applyTaskChange(snapshot, {
      revision: 4,
      task: { ...task, status: "running" },
      removed: [],
    }),
  ).toBe(snapshot);
  expect(
    applyTaskChange(snapshot, { revision: 6, task, removed: ["a"] }).tasks,
  ).toEqual([]);
});
