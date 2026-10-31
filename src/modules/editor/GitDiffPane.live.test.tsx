vi.mock("@/modules/explorer/lib/watchHealth", () => ({
  watchHealth: {
    retry: vi.fn(async () => {}),
    subscribe: () => ({
      ready: Promise.resolve(),
      current: () => ({ revision: 0, error: null }),
      refresh: async () => {},
      dispose: vi.fn(),
    }),
  },
}));
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  cells: [] as unknown[],
  index: 0,
  effectCells: [] as { deps: unknown[]; cleanup?: () => void }[],
  effectIndex: 0,
  effects: [] as (() => void)[],
  read: vi.fn(),
  watch: vi.fn(),
  changed: () => {},
  healthChanged: (_status: { revision: number; error: string | null }) => {},
  env: { kind: "local" as const },
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
  useMemo: (fn: () => unknown) => fn(),
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const i = fake.effectIndex++,
      previous = fake.effectCells[i];
    if (!previous || deps.some((d, j) => !Object.is(d, previous.deps[j])))
      fake.effects.push(() => {
        previous?.cleanup?.();
        fake.effectCells[i] = { deps, cleanup: effect() };
      });
  },
}));
vi.mock("@/modules/workspace/owner", () => ({
  useOwnedWorkspace: () => fake.env,
}));
vi.mock("@/modules/workspace/env", () => ({
  workspaceScopeKey: () => "local",
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceScopeKey: () => "local",
}));
vi.mock("@/modules/ai/lib/native", () => ({
  native: { gitDiffContent: fake.read },
  createNative: () => ({ gitDiffContent: fake.read }),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: () => "split",
}));
vi.mock("@/modules/settings/store", () => ({ setDiffViewMode: vi.fn() }));
vi.mock("./lib/extensions", () => ({
  buildSharedExtensions: () => [],
  DEFAULT_INDENT: [],
  languageCompartment: { of: () => [] },
}));
vi.mock("./lib/useEditorThemeExt", () => ({ useEditorThemeExt: () => [] }));
vi.mock("./lib/languageResolver", () => ({
  resolveLanguage: async () => ({ ext: [] }),
  resolveLanguageSync: () => ({ ext: [] }),
}));
vi.mock("./SplitDiffView", () => ({ SplitDiffView: () => null }));
vi.mock("./lib/watchWorkingDiff", () => ({ watchWorkingDiff: fake.watch }));
import { GitDiffPane } from "./GitDiffPane";
import { SplitDiffView } from "./SplitDiffView";
import { invalidateRepoDiffs } from "./lib/diffCache";
const source = {
  kind: "working" as const,
  repoRoot: "/repo",
  path: "file.txt",
  mode: "-" as const,
  originalPath: null,
};
function render() {
  fake.index = 0;
  fake.effectIndex = 0;
  fake.effects = [];
  const output = GitDiffPane({ active: true, source });
  for (const effect of fake.effects) effect();
  return output;
}
function walk(
  value: unknown,
): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(value)) return value.flatMap(walk);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as { type: unknown; props: Record<string, unknown> };
  return [node, ...walk(node.props.children)];
}
beforeEach(() => {
  fake.cells = [];
  fake.effectCells = [];
  fake.read.mockReset();
  fake.watch
    .mockReset()
    .mockImplementation((_root, _path, _env, changed, healthChanged) => {
      fake.changed = changed;
      fake.healthChanged = healthChanged;
      return {
        ready: Promise.resolve(),
        health: () => ({ revision: 0, error: null }),
        dispose: vi.fn(),
      };
    });
  invalidateRepoDiffs("/repo", fake.env);
});
it("refreshes an open working diff after source-control invalidates its content", async () => {
  fake.read.mockResolvedValue({
    originalContent: "base",
    modifiedContent: "old",
    isBinary: false,
    fallbackPatch: "",
    truncated: false,
  });
  render();
  await vi.waitFor(() =>
    expect(
      fake.cells.some(
        (v) => (v as { modifiedContent?: string })?.modifiedContent === "old",
      ),
    ).toBe(true),
  );
  render();
  fake.read.mockResolvedValue({
    originalContent: "base",
    modifiedContent: "new",
    isBinary: false,
    fallbackPatch: "",
    truncated: false,
  });
  invalidateRepoDiffs("/repo", fake.env);
  render();
  await vi.waitFor(
    () =>
      expect(
        fake.cells.some(
          (v) => (v as { modifiedContent?: string })?.modifiedContent === "new",
        ),
      ).toBe(true),
    { timeout: 100 },
  );
});

afterEach(() => {
  for (const effect of fake.effectCells) effect.cleanup?.();
});

it("keeps the diff editor mounted while refreshing so scroll and expanded regions survive", async () => {
  const content = {
    originalContent: "base",
    modifiedContent: "old",
    isBinary: false,
    fallbackPatch: "",
    truncated: false,
  };
  fake.read.mockResolvedValue(content);
  render();
  await vi.waitFor(() =>
    expect(walk(render()).some((n) => n.type === SplitDiffView)).toBe(true),
  );
  let finish!: (value: typeof content) => void;
  fake.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fake.changed();
  const refreshing = render();
  expect(
    walk(refreshing).find((n) => n.type === SplitDiffView)?.props.modified,
  ).toBe("old");
  expect(
    walk(refreshing).some((n) => n.props["aria-label"] === "Refreshing diff"),
  ).toBe(true);
  await vi.waitFor(() => expect(fake.read).toHaveBeenCalledTimes(2));
  finish({ ...content, modifiedContent: "new" });
  await vi.waitFor(() =>
    expect(
      walk(render()).find((n) => n.type === SplitDiffView)?.props.modified,
    ).toBe("new"),
  );
  expect(
    walk(render()).some((n) => n.props["aria-label"] === "Refreshing diff"),
  ).toBe(false);
});

it("shows a watch failure and retries registration without keeping old content", async () => {
  fake.watch.mockImplementationOnce(() => ({
    ready: Promise.reject(new Error("watch denied")),
    dispose: vi.fn(),
  }));
  render();
  await vi.waitFor(() =>
    expect(
      fake.cells.some((v) =>
        (v as { message?: string })?.message?.includes("watch denied"),
      ),
    ).toBe(true),
  );
  const retry = walk(render()).find((n) => n.props.children === "Retry");
  expect(retry).toBeDefined();
  if (!retry) throw new Error("Missing Retry button");
  (retry.props.onClick as () => void)();
  await Promise.resolve();
  fake.read.mockResolvedValue({
    originalContent: "base",
    modifiedContent: "recovered",
    isBinary: false,
    fallbackPatch: "",
    truncated: false,
  });
  render();
  await vi.waitFor(() =>
    expect(
      fake.cells.some(
        (v) =>
          (v as { modifiedContent?: string })?.modifiedContent === "recovered",
      ),
    ).toBe(true),
  );
});

it("refreshes for external changes and shows subsequent read failures", async () => {
  fake.read.mockResolvedValue({
    originalContent: "base",
    modifiedContent: "old",
    isBinary: false,
    fallbackPatch: "",
    truncated: false,
  });
  render();
  await vi.waitFor(() =>
    expect(
      fake.cells.some(
        (v) => (v as { modifiedContent?: string })?.modifiedContent === "old",
      ),
    ).toBe(true),
  );
  fake.read.mockRejectedValueOnce(new Error("read denied"));
  fake.changed();
  await vi.waitFor(() =>
    expect(
      fake.cells.some((v) =>
        (v as { message?: string })?.message?.includes("read denied"),
      ),
    ).toBe(true),
  );
});

it("shows lost coverage in an already-open diff and reloads on recovery", async () => {
  const content = {
    originalContent: "base",
    modifiedContent: "old",
    isBinary: false,
    fallbackPatch: "",
    truncated: false,
  };
  fake.read.mockResolvedValue(content);
  render();
  await vi.waitFor(() =>
    expect(
      walk(render()).find((n) => n.type === SplitDiffView)?.props.modified,
    ).toBe("old"),
  );
  fake.healthChanged({ revision: 1, error: "watcher stopped" });
  expect(
    walk(render()).some(
      (n) => n.props.children === "Could not refresh diff: watcher stopped",
    ),
  ).toBe(true);
  fake.read.mockResolvedValue({ ...content, modifiedContent: "recovered" });
  fake.healthChanged({ revision: 2, error: null });
  await vi.waitFor(() =>
    expect(
      walk(render()).find((n) => n.type === SplitDiffView)?.props.modified,
    ).toBe("recovered"),
  );
});
