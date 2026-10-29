import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  cells: [] as unknown[],
  refs: [] as { current: unknown }[],
  index: 0,
  refIndex: 0,
  memos: [] as { value: unknown; deps: unknown[] }[],
  memoIndex: 0,
  effectCells: [] as { deps: unknown[]; cleanup?: () => void }[],
  effectIndex: 0,
  env: { kind: "local" } as { kind: string; distro?: string },
  space: "space-a",
  calls: [] as { root: string; env: unknown }[],
  effects: [] as (() => unknown)[],
  commit: vi.fn(),
  invalidate: vi.fn(),
  discard: vi.fn(),
  generate: vi.fn(),
  diff: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
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
    const i = fake.refIndex++;
    fake.refs[i] ??= { current: initial };
    return fake.refs[i];
  },
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const i = fake.effectIndex++,
      previous = fake.effectCells[i];
    if (!previous || deps.some((d, j) => !Object.is(d, previous.deps[j]))) {
      fake.effects.push(() => {
        previous?.cleanup?.();
        fake.effectCells[i] = { deps, cleanup: effect() || undefined };
      });
    }
  },
  useMemo: (fn: () => unknown, deps: unknown[]) => {
    const i = fake.memoIndex++,
      previous = fake.memos[i];
    if (!previous || deps.some((d, j) => !Object.is(d, previous.deps[j])))
      fake.memos[i] = { deps, value: fn() };
    return fake.memos[i].value;
  },
  useCallback: (fn: unknown) => fn,
}));
vi.mock("@/modules/settings/readiness", () => ({
  requireCurrentPreferences: () => {},
}));
vi.mock("@/modules/workspace/env", () => ({
  currentWorkspaceEnv: () => fake.env,
  workspaceScopeKey: (env: typeof fake.env) =>
    `${env.kind}:${env.distro ?? ""}`,
  useWorkspaceEnvStore: (
    select: (state: { env: typeof fake.env }) => unknown,
  ) => select({ env: fake.env }),
}));
vi.mock("@/modules/spaces/lib/useSpaces", () => ({
  useSpaces: Object.assign(
    (select: (state: { activeId: string }) => unknown) =>
      select({ activeId: fake.space }),
    { getState: () => ({ activeId: fake.space }) },
  ),
}));
vi.mock("@/modules/ai/lib/native", async () => {
  const { DiscardCoordinator } = await import(
    "@/modules/editor/lib/discardCoordinator"
  );
  const { prepareNativeDiscard } = await import(
    "@/modules/editor/lib/gitSignals"
  );
  return {
    createNative: (
      env: () => import("@/modules/workspace/env").WorkspaceEnv,
    ) => ({
      gitDiscard: async (
        root: string,
        entries: { path: string; untracked: boolean }[],
      ) => {
        fake.calls.push({ root, env: env() });
        const client = new DiscardCoordinator({
          prepare: (scope, preserve) =>
            prepareNativeDiscard(
              scope.workspace,
              preserve,
              async (_id, _token, paths) =>
                paths.map((path) =>
                  entries.some((entry) => path === `${root}/${entry.path}`),
                ),
            ),
          problem: () => {},
          invoke: async <T>(command: string) => {
            if (command === "git_discard_begin") return "1" as T;
            if (command === "git_discard") await fake.discard(root, entries);
            if (command === "git_discard_cancel")
              return { phase: "finished", ok: false } as T;
            return undefined as T;
          },
        });
        client.ready("test");
        try {
          await client.execute({ repoRoot: root, entries, workspace: env() });
        } finally {
          client.dispose();
        }
      },
      gitCommit: async (root: string, message: string) => {
        fake.calls.push({ root, env: env() });
        return fake.commit(root, message);
      },
      gitAiStagedDiff: fake.diff,
    }),
  };
});
vi.mock("@/modules/ai/lib/agent", () => ({
  buildConfiguredLanguageModel: async () => "model",
}));
vi.mock("ai", () => ({ generateText: fake.generate }));
vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: Object.assign(
    (select: (state: unknown) => unknown) =>
      select({ selectedModelId: "gpt-test", agentMeta: { status: "idle" } }),
    { getState: () => ({ apiKeys: {} }) },
  ),
}));
vi.mock("@/modules/ai/store/modelConfig", () => ({
  liveModelConfig: () => ({}),
  useSelectedModelProblem: () => null,
}));
vi.mock("@/modules/ai/config", () => ({
  modelSupportsTemperature: () => true,
  resolveModel: () => ({ provider: "openai", id: "test" }),
}));
vi.mock("@/modules/editor/lib/diffCache", () => ({
  invalidateWorkingDiff: () => {},
  invalidateRepoDiffs: fake.invalidate,
  workingDiffKey: () => "key",
}));
vi.mock("@/modules/mac-privacy", () => ({ showPrivacyRefusal: () => {} }));
import { useSourceControlPanel } from "./useSourceControlPanel";
function summary(root: string) {
  return {
    repo: { repoRoot: root, branch: "main", upstream: null, isDetached: false },
    hasRepo: true,
    isLoading: false,
    localError: null,
    busyAction: null,
    status: {
      changedFiles: [
        {
          path: "same.txt",
          indexStatus: "M",
          worktreeStatus: "M",
          staged: true,
          unstaged: true,
          untracked: false,
          statusCode: "M",
          statusLabel: "Modified",
          originalPath: null,
        },
      ],
      ahead: 0,
      behind: 0,
    },
    refresh: async () => {},
    applyStatus: () => {},
  } as unknown as Parameters<typeof useSourceControlPanel>[1];
}
function render(s: ReturnType<typeof summary>, open = true) {
  fake.index = 0;
  fake.refIndex = 0;
  fake.memoIndex = 0;
  fake.effectIndex = 0;
  fake.effects = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: deterministic hook lifecycle harness
  const panel = useSourceControlPanel(open, s, null);
  for (const effect of fake.effects) effect();
  return panel;
}
beforeEach(() => {
  fake.cells = [];
  fake.refs = [];
  fake.memos = [];
  fake.effectCells = [];
  fake.env = { kind: "local" };
  fake.space = "space-a";
  fake.calls = [];
  fake.discard.mockReset();
  fake.commit.mockReset();
  fake.invalidate.mockReset();
  fake.diff.mockReset();
  fake.generate.mockReset();
  vi.stubGlobal("window", { setTimeout: () => 1, clearTimeout: () => {} });
});
afterEach(() => {
  for (const effect of fake.effectCells) effect.cleanup?.();
  vi.unstubAllGlobals();
});
it("does not apply a prior repository's discard confirmation to the new repository", async () => {
  const a = summary("/repo-a"),
    b = summary("/repo-b");
  render(a);
  let panel = render(a);
  panel.requestDiscardEntry(panel.unstagedEntries[0]);
  render(a);
  render(b);
  panel = render(b);
  await panel.confirmPendingDiscard();
  expect(fake.discard).not.toHaveBeenCalled();
});
it("does not replace the new repository's typed draft with an old AI result", async () => {
  let finish!: (result: { text: string }) => void;
  fake.generate.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fake.diff.mockResolvedValue({
    paths: ["same.txt"],
    diffText: "synthetic change",
    truncated: false,
  });
  const a = summary("/repo-a"),
    b = summary("/repo-b");
  render(a);
  const pending = render(a).generateCommitMessage();
  await vi.waitFor(() => expect(finish).toBeDefined());
  render(b);
  render(b).setCommitMessage("fix: user's new draft");
  finish({ text: "fix: old repository changes" });
  await pending;
  expect(render(b).commitMessage).toBe("fix: user's new draft");
});
it("does not send a protected staged file from Git to the commit-message model", async () => {
  const a = summary("/repo-a");
  if (a.status) a.status.changedFiles[0].path = ".env";
  fake.diff.mockRejectedValue(
    new Error("AI commit-message generation refused: protected path"),
  );
  fake.generate.mockResolvedValue({ text: "fix: synthetic changes" });
  render(a);
  await render(a).generateCommitMessage();
  expect(fake.generate).not.toHaveBeenCalled();
  expect(render(a).actionError).toContain("protected path");
});
it("does not overwrite a newer typed draft in the same repository", async () => {
  let finish!: (result: { text: string }) => void;
  fake.generate.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fake.diff.mockResolvedValue({
    paths: ["same.txt"],
    diffText: "synthetic change",
    truncated: false,
  });
  const a = summary("/repo-a");
  render(a);
  const pending = render(a).generateCommitMessage();
  await vi.waitFor(() => expect(finish).toBeDefined());
  render(a).setCommitMessage("fix: my newer draft");
  finish({ text: "fix: old generated draft" });
  await pending;
  expect(render(a).commitMessage).toBe("fix: my newer draft");
});

it.each(["space", "environment", "close"])(
  "cancels an open confirmation on %s changes even for the same repository",
  async (change) => {
    const a = summary("/repo-a");
    render(a);
    let panel = render(a);
    panel.requestDiscardEntry(panel.unstagedEntries[0]);
    const stale = render(a);
    if (change === "space") fake.space = "space-b";
    if (change === "environment") fake.env = { kind: "wsl", distro: "Debian" };
    panel = render(a, change !== "close");
    expect(panel.pendingDiscard).toBeNull();
    await stale.confirmPendingDiscard();
    await panel.confirmPendingDiscard();
    expect(fake.discard).not.toHaveBeenCalled();
  },
);

it("keeps an already-dispatched discard in its original environment and leaves new errors alone", async () => {
  let reject!: (error: Error) => void;
  fake.discard.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  fake.env = { kind: "wsl", distro: "Ubuntu" };
  const a = summary("/project");
  render(a);
  const panel = render(a);
  panel.requestDiscardEntry(panel.unstagedEntries[0]);
  const pending = render(a).confirmPendingDiscard();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  fake.env = { kind: "wsl", distro: "Debian" };
  render(a);
  reject(new Error("old distribution failed"));
  await pending;
  expect(fake.calls).toEqual([
    { root: "/project", env: { kind: "wsl", distro: "Ubuntu" } },
  ]);
  expect(render(a).actionError).toBeNull();
});

it("abandons a pending Git snapshot before model startup when navigation changes", async () => {
  let finish!: (result: unknown) => void;
  fake.diff.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const a = summary("/repo-a");
  render(a);
  const pending = render(a).generateCommitMessage();
  render(summary("/repo-b"));
  finish({ paths: ["same.txt"], diffText: "ordinary", truncated: false });
  await pending;
  expect(fake.generate).not.toHaveBeenCalled();
});

it.each(["edit", "close", "unmount", "space"])(
  "aborts the model on %s and ignores a late invalid answer without repair",
  async (change) => {
    let finish!: (result: { text: string }) => void;
    fake.diff.mockResolvedValue({
      paths: ["verified.txt"],
      diffText: "ordinary",
      truncated: false,
    });
    fake.generate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const a = summary("/repo-a");
    render(a);
    const pending = render(a).generateCommitMessage();
    await vi.waitFor(() => expect(finish).toBeDefined());
    const signal = fake.generate.mock.calls[0][0].abortSignal as AbortSignal;
    if (change === "edit") render(a).setCommitMessage("fix: my text");
    if (change === "close") render(a, false);
    if (change === "unmount")
      for (const effect of fake.effectCells) effect.cleanup?.();
    if (change === "space") {
      fake.space = "space-b";
      render(a);
    }
    expect(signal.aborted).toBe(true);
    finish({ text: "invalid answer" });
    await pending;
    expect(fake.generate).toHaveBeenCalledTimes(1);
  },
);

it("uses only snapshot paths in both prompts and propagates native truncation", async () => {
  fake.diff.mockResolvedValue({
    paths: ["verified.txt"],
    diffText: "ordinary",
    truncated: true,
  });
  fake.generate
    .mockResolvedValueOnce({ text: "invalid" })
    .mockResolvedValueOnce({ text: "fix: staged change" });
  const a = summary("/repo-a");
  render(a);
  await render(a).generateCommitMessage();
  expect(fake.generate).toHaveBeenCalledTimes(2);
  for (const [input] of fake.generate.mock.calls) {
    expect(input.prompt).toContain("verified.txt");
    expect(input.prompt).not.toContain("same.txt");
  }
  expect(fake.generate.mock.calls[0][0].prompt).toContain("was truncated");
  expect(render(a).commitMessage).toBe("fix: staged change");
});

it("keeps a late commit bound to its environment without erasing the next space's draft", async () => {
  let finish!: (result: unknown) => void;
  fake.commit.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fake.env = { kind: "wsl", distro: "Ubuntu" };
  const a = summary("/project");
  render(a);
  render(a).setCommitMessage("fix: original message");
  const pending = render(a).commit();
  fake.env = { kind: "wsl", distro: "Debian" };
  render(a);
  render(a).setCommitMessage("fix: new draft");
  finish({ commitSha: "abc1234", summary: "original message" });
  await pending;
  expect(fake.calls).toEqual([
    { root: "/project", env: { kind: "wsl", distro: "Ubuntu" } },
  ]);
  expect(fake.invalidate).toHaveBeenLastCalledWith("/project", {
    kind: "wsl",
    distro: "Ubuntu",
  });
  expect(render(a).commitMessage).toBe("fix: new draft");
  expect(render(a).actionMessage).toBeNull();
});

it("discard preserves editor changes typed after confirmation while native Git is running", async () => {
  const { DocumentSession } = await import(
    "@/modules/editor/lib/documentSession"
  );
  const { registerDiscardDocument } = await import(
    "@/modules/editor/lib/gitSignals"
  );
  let disk = "disk changes";
  const session = new DocumentSession(
    {
      read: async () => ({
        kind: "text",
        content: disk,
        version: disk,
        size: disk.length,
        mtime: 1,
      }),
      write: async () => ({ kind: "saved", version: "unused" }),
    },
    {
      state: vi.fn(),
      dirty: vi.fn(),
      saved: vi.fn(),
      saveFailed: vi.fn(),
      conflict: vi.fn(),
      released: vi.fn(),
      autoSave: () => ({ enabled: false, delay: 50 }),
    },
  );
  session.open("/repo/same.txt");
  for (let i = 0; i < 20; i++) await Promise.resolve();
  session.change("previous draft");
  // Observe the production coordinator's confirmation-time preparation.
  const stop = registerDiscardDocument({
    path: "/repo/same.txt",
    workspace: { kind: "local" },
    prepare: session.prepareDiscard,
    stage: session.stageDiscard,
  });
  let finish!: () => void;
  fake.discard.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          disk = "HEAD version";
          resolve();
        };
      }),
  );
  const state = summary("/repo");
  render(state);
  let panel = render(state);
  panel.requestDiscardAll();
  panel = render(state);
  const discarding = panel.confirmPendingDiscard();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  session.change("new work typed after confirmation");
  finish();
  await discarding;
  for (let i = 0; i < 20; i++) await Promise.resolve();
  try {
    expect(session.text()).toBe("new work typed after confirmation");
  } finally {
    stop();
    session.close();
  }
});
