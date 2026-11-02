import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
const fake = vi.hoisted(() => ({
  cells: [] as unknown[],
  index: 0,
  effects: [] as (() => unknown)[],
  env: { kind: "wsl", distro: "Ubuntu" },
  space: "a",
  invoke: vi.fn(),
  removed: vi.fn(),
  created: vi.fn(),
  root: "/project",
}));
vi.mock("react", async (original) => ({
  ...(await original<object>()),
  useState: (initial: unknown) => {
    const i = fake.index++;
    if (!(i in fake.cells))
      fake.cells[i] = typeof initial === "function" ? initial() : initial;
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
  useEffect: (effect: () => unknown) => fake.effects.push(effect),
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useId: () => "test-id",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => fake.env }));
vi.mock("@/modules/workspace/env", () => ({
  currentWorkspaceEnv: () => fake.env,
  workspaceScopeKey: (env: typeof fake.env) => env.distro,
  useWorkspaceEnvStore: (select: (s: { env: typeof fake.env }) => unknown) =>
    select({ env: fake.env }),
}));
vi.mock("@/modules/spaces/lib/useSpaces", () => ({
  useSpaces: Object.assign(
    (select: (s: { activeId: string }) => unknown) =>
      select({ activeId: fake.space }),
    { getState: () => ({ activeId: fake.space }) },
  ),
}));
import { NewWorktreeDialog, RemoveWorktreeDialog } from "./WorktreeDialogs";
type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const worktrees = [
  {
    path: "/project-other",
    branch: "other",
    head: "abc",
    isMain: false,
    isBare: false,
    isCurrent: false,
    locked: null,
    prunable: false,
  },
];
function render(kind: "remove" | "new" = "remove") {
  fake.index = 0;
  const dialog =
    kind === "new"
      ? NewWorktreeDialog({
          open: true,
          onOpenChange: () => {},
          repoRoot: fake.root,
          worktrees,
          branches: [],
          headLabel: "main",
          onCreated: fake.created,
        })
      : RemoveWorktreeDialog({
          open: true,
          onOpenChange: () => {},
          repoRoot: fake.root,
          worktrees,
          onRemoved: fake.removed,
        });
  const form = nodes(dialog).find(
    (n) =>
      typeof n.type === "function" &&
      n.type.name ===
        (kind === "new" ? "NewWorktreeForm" : "RemoveWorktreeForm"),
  );
  if (!form || typeof form.type !== "function") throw new Error("missing form");
  return nodes((form.type as (props: unknown) => unknown)(form.props));
}
function click(label: string) {
  const button = render().find(
    (n) =>
      typeof n.props.onClick === "function" &&
      (n.props.children === label ||
        (Array.isArray(n.props.children) && n.props.children.includes(label))),
  );
  if (!button) throw new Error(`missing button ${label}`);
  (button.props.onClick as () => void)();
}
beforeEach(() => {
  fake.cells = [];
  fake.effects = [];
  fake.env = { kind: "wsl", distro: "Ubuntu" };
  fake.space = "a";
  fake.invoke.mockReset();
  fake.removed.mockReset();
  fake.created.mockReset();
  fake.root = "/project";
});
it("does not force-remove a worktree in another distribution from an old confirmation", async () => {
  fake.invoke.mockResolvedValue({ removed: false, changes: 3 });
  click("Remove");
  await vi.waitFor(() =>
    expect(
      render().some(
        (n) =>
          Array.isArray(n.props.children) &&
          n.props.children.includes("Remove Anyway"),
      ),
    ).toBe(true),
  );
  fake.env = { kind: "wsl", distro: "Debian" };
  click("Remove Anyway");
  expect(fake.invoke).toHaveBeenCalledTimes(1);
});

it.each(["space", "repository"])(
  "expires force-removal on %s navigation",
  async (change) => {
    fake.invoke.mockResolvedValue({ removed: false, changes: 3 });
    click("Remove");
    await vi.waitFor(() =>
      expect(
        render().some(
          (n) =>
            Array.isArray(n.props.children) &&
            n.props.children.includes("Remove Anyway"),
        ),
      ).toBe(true),
    );
    if (change === "space") fake.space = "b";
    else fake.root = "/new-project";
    click("Remove Anyway");
    expect(fake.invoke).toHaveBeenCalledTimes(1);
  },
);

it("allows a valid second confirmation in the same environment", async () => {
  fake.invoke
    .mockResolvedValueOnce({ removed: false, changes: 3 })
    .mockResolvedValueOnce({ removed: true, changes: 0 });
  click("Remove");
  await vi.waitFor(() =>
    expect(
      render().some(
        (n) =>
          Array.isArray(n.props.children) &&
          n.props.children.includes("Remove Anyway"),
      ),
    ).toBe(true),
  );
  click("Remove Anyway");
  await vi.waitFor(() => expect(fake.removed).toHaveBeenCalledOnce());
  expect(fake.invoke).toHaveBeenLastCalledWith("git_worktree_remove", {
    repoRoot: "/project",
    path: "/project-other",
    force: true,
    workspace: { kind: "wsl", distro: "Ubuntu" },
  });
});

it("does not apply a late removal result to the next space", async () => {
  let finish!: (result: unknown) => void;
  fake.invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  click("Remove");
  fake.space = "b";
  finish({ removed: true, changes: 0 });
  await Promise.resolve();
  await Promise.resolve();
  expect(fake.removed).not.toHaveBeenCalled();
  expect(fake.invoke.mock.calls[0][1].workspace.distro).toBe("Ubuntu");
});

function preparedNewForm() {
  const field = render("new").find(
    (n) =>
      n.props.id === "test-id-name" && typeof n.props.onChange === "function",
  );
  if (!field) throw new Error("missing branch input");
  (field.props.onChange as (event: unknown) => void)({
    target: { value: "topic" },
  });
  const form = render("new").find(
    (n) => typeof n.props.onSubmit === "function",
  );
  if (!form) throw new Error("missing form");
  return () =>
    (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
}

it("does not create a worktree from a stale form", () => {
  const submit = preparedNewForm();
  fake.env = { kind: "wsl", distro: "Debian" };
  submit();
  expect(fake.invoke).not.toHaveBeenCalled();
});

it("keeps creation in its original environment, ignores late navigation, and blocks double submit", async () => {
  let finish!: (result: unknown) => void;
  fake.invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const submit = preparedNewForm();
  submit();
  submit();
  expect(fake.invoke).toHaveBeenCalledOnce();
  expect(fake.invoke.mock.calls[0][1].workspace.distro).toBe("Ubuntu");
  fake.env = { kind: "wsl", distro: "Debian" };
  finish({ path: "/project-topic", branch: "topic" });
  await Promise.resolve();
  await Promise.resolve();
  expect(fake.created).not.toHaveBeenCalled();
});

it("does not submit after the form unmounts", () => {
  const submit = preparedNewForm();
  for (const effect of fake.effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanup();
  }
  submit();
  expect(fake.invoke).not.toHaveBeenCalled();
});
