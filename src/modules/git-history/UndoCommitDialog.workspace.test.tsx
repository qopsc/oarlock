import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { GitLogEntry } from "@/modules/ai/lib/native";
const fake = vi.hoisted(() => ({
  cells: [] as unknown[],
  index: 0,
  effects: [] as (() => unknown)[],
  env: { kind: "wsl", distro: "Ubuntu" },
  space: "a",
  owned: { kind: "wsl", distro: "Ubuntu" },
  invoke: vi.fn(),
  closed: vi.fn(),
  undone: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<object>()),
  useState: (initial: unknown) => {
    const i = fake.index++;
    if (!(i in fake.cells)) fake.cells[i] = initial;
    return [
      fake.cells[i],
      (value: unknown) => {
        fake.cells[i] =
          typeof value === "function" ? value(fake.cells[i]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = fake.index++;
    fake.cells[i] ??= { current: initial };
    return fake.cells[i];
  },
  useMemo: (fn: () => unknown) => fn(),
  useEffect: (fn: () => unknown) => {
    fake.effects.push(fn);
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => fake.env }));
vi.mock("@/modules/workspace/env", () => ({
  currentWorkspaceEnv: () => fake.env,
  workspaceScopeKey: (env: typeof fake.env) => env.distro,
}));
vi.mock("@/modules/workspace/owner", () => ({
  useOwnedWorkspace: () => fake.owned,
}));
vi.mock("@/modules/spaces/lib/useSpaces", () => ({
  useSpaces: { getState: () => ({ activeId: fake.space }) },
}));
vi.mock("sonner", () => ({ toast: { success: fake.success } }));
vi.mock("@/modules/mac-privacy", () => ({ showFileError: fake.error }));
import { UndoCommitDialog } from "./UndoCommitDialog";
import { AlertDialogAction } from "@/components/ui/alert-dialog";
type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function render() {
  fake.index = 0;
  const tree = UndoCommitDialog({
    repoRoot: "/repo",
    target: {
      commit: {
        sha: "a".repeat(40),
        shortSha: "aaaaaaa",
        subject: "second",
      } as GitLogEntry,
      branch: "main",
    },
    onClose: fake.closed,
    onUndone: fake.undone,
  });
  const cleanups = fake.effects
    .splice(0)
    .map((fn) => fn())
    .filter((fn): fn is () => void => typeof fn === "function");
  const action = nodes(tree).find((n) => n.type === AlertDialogAction);
  if (!action) throw new Error("Undo action missing");
  return {
    tree,
    click: action.props.onClick as () => void,
    dispose: () => {
      for (const fn of cleanups) fn();
    },
  };
}
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
beforeEach(() => {
  fake.cells = [];
  fake.effects = [];
  fake.env = { kind: "wsl", distro: "Ubuntu" };
  fake.owned = fake.env;
  fake.space = "a";
  vi.clearAllMocks();
  fake.invoke.mockResolvedValue(null);
});
it("keeps dispatched work in its environment and suppresses completion after navigation", async () => {
  let finish!: () => void;
  fake.invoke.mockImplementation((command) =>
    command === "git_undo_commit"
      ? new Promise<void>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(null),
  );
  render();
  await settle();
  const dialog = render();
  dialog.click();
  expect(fake.invoke).toHaveBeenCalledWith("git_undo_commit", {
    repoRoot: "/repo",
    expectedHead: "a".repeat(40),
    expectedBranch: "main",
    workspace: fake.owned,
  });
  fake.env = { kind: "wsl", distro: "Debian" };
  fake.space = "b";
  finish();
  await settle();
  expect(fake.undone).not.toHaveBeenCalled();
  expect(fake.success).not.toHaveBeenCalled();
});
it("rejects a stale confirmation before dispatch even before React unmounts it", async () => {
  render();
  await settle();
  const dialog = render();
  fake.space = "b";
  dialog.click();
  expect(
    fake.invoke.mock.calls.some(([command]) => command === "git_undo_commit"),
  ).toBe(false);
  expect(fake.closed).not.toHaveBeenCalled();
});
it("does not refresh a closed history pane after Undo completes", async () => {
  let finish!: () => void;
  fake.invoke.mockImplementation((command) =>
    command === "git_undo_commit"
      ? new Promise<void>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(null),
  );
  render();
  await settle();
  const dialog = render();
  dialog.click();
  dialog.dispose();
  finish();
  await settle();
  expect(fake.undone).not.toHaveBeenCalled();
});
it("refreshes after a successful Undo in the same owner", async () => {
  render();
  await settle();
  const dialog = render();
  dialog.click();
  await settle();
  expect(fake.undone).toHaveBeenCalledOnce();
  expect(fake.success).toHaveBeenCalledOnce();
});

it("keeps Undo disabled when the remote check fails instead of treating the commit as unshared", async () => {
  fake.invoke.mockRejectedValue(new Error("lookup failed"));
  render();
  await settle();
  const dialog = render();
  const action = nodes(dialog.tree).find((n) => n.type === AlertDialogAction);
  if (!action) throw new Error("Undo action missing");
  expect(action.props.disabled).toBe(true);
  expect(nodes(dialog.tree).some((n) => n.props.role === "alert")).toBe(true);
  dialog.click();
  expect(
    fake.invoke.mock.calls.some(([command]) => command === "git_undo_commit"),
  ).toBe(false);
});
