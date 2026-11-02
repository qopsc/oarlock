import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
const fake = vi.hoisted(() => ({
  env: { kind: "wsl", distro: "Ubuntu" },
  owned: { kind: "wsl", distro: "Ubuntu" },
  effects: [] as (() => unknown)[],
  invoke: vi.fn(async () => []),
}));
vi.mock("react", async (original) => ({
  ...(await original<object>()),
  useState: (initial: unknown) => [initial, vi.fn()],
  useRef: (initial: unknown) => ({ current: initial }),
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useDeferredValue: (value: unknown) => value,
  useEffect: (fn: () => unknown) => {
    fake.effects.push(fn);
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => fake.env }));
vi.mock("@/modules/workspace/owner", () => ({
  useOwnedWorkspace: () => fake.owned,
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({ getVirtualItems: () => [], getTotalSize: () => 0 }),
}));
vi.mock("./UndoCommitDialog", () => ({ UndoCommitDialog: () => null }));
import { GitHistoryPane } from "./GitHistoryPane";
import { UndoCommitDialog } from "./UndoCommitDialog";
type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
it("binds delayed refreshes to the owning space and stops them after unmount", async () => {
  const tree = GitHistoryPane({
    repoRoot: "/repo",
    onOpenCommitFile: () => {},
  });
  const cleanups = fake.effects
    .splice(0)
    .map((fn) => fn())
    .filter((fn): fn is () => void => typeof fn === "function");
  const dialog = nodes(tree).find((node) => node.type === UndoCommitDialog);
  if (!dialog) throw new Error("Undo dialog missing");
  const refresh = dialog.props.onUndone as () => void;
  fake.env = { kind: "wsl", distro: "Debian" };
  refresh();
  expect(fake.invoke).toHaveBeenLastCalledWith("git_log", {
    repoRoot: "/repo",
    limit: 30,
    skip: null,
    anchorSha: null,
    workspace: fake.owned,
  });
  for (const cleanup of cleanups) cleanup();
  fake.invoke.mockClear();
  refresh();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(fake.invoke).not.toHaveBeenCalled();
});
