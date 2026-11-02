vi.mock("@/lib/platform", () => ({ IS_WINDOWS: true }));
import { beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  env: { kind: "wsl", distro: "Ubuntu" },
  calls: [] as { command: string; distro: string }[],
  fetch: Promise.resolve(),
  refs: [] as { current: unknown }[],
  refIndex: 0,
  setState: vi.fn(),
  state: {
    contextPath: "/project",
    hasRepo: true,
    isLoading: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
    repo: {
      repoRoot: "/project",
      branch: "main",
      upstream: "origin/main",
      isDetached: false,
      linkedWorktree: null,
    },
    status: {
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 1,
      changedFiles: [],
    },
  },
}));
vi.mock("react", async (actual) => ({
  ...(await actual<typeof import("react")>()),
  useState: () => [harness.state, harness.setState],
  useRef: (value: unknown) => {
    const index = harness.refIndex++;
    harness.refs[index] ??= { current: value };
    return harness.refs[index];
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => harness.env,
  workspaceScopeKey: (env: typeof harness.env) => `wsl:${env.distro}`,
  useWorkspaceEnvStore: (
    select: (state: { env: typeof harness.env }) => unknown,
  ) => select({ env: harness.env }),
}));
vi.mock("@/modules/ai/lib/native", () => {
  const createNative = (getEnv = () => harness.env) => ({
    gitFetch: async () => {
      harness.calls.push({ command: "fetch", distro: getEnv().distro });
      await harness.fetch;
    },
    gitPullFfOnly: async () => {
      harness.calls.push({ command: "pull", distro: getEnv().distro });
    },
    gitPanelSnapshot: async () => ({
      repo: harness.state.repo,
      status: harness.state.status,
    }),
    gitStatus: async () => harness.state.status,
  });
  return { native: createNative(), createNative };
});
vi.mock("@/modules/editor/lib/gitSignals", () => ({
  notifyHeadMoved: vi.fn(),
}));

import { useSourceControl } from "./useSourceControl";

beforeEach(() => {
  harness.env = { kind: "wsl", distro: "Ubuntu" };
  harness.calls.length = 0;
  harness.refs.length = 0;
  harness.refIndex = 0;
  harness.setState.mockClear();
});

it("keeps fetch and pull in the originating distribution after a space switch", async () => {
  let fetched!: () => void;
  harness.fetch = new Promise<void>((resolve) => {
    fetched = resolve;
  });
  const summary = useSourceControl("/project", true);
  const pending = summary.runRemoteAction("pull");
  expect(harness.calls).toEqual([{ command: "fetch", distro: "Ubuntu" }]);
  harness.env = { kind: "wsl", distro: "Debian" };
  fetched();
  await pending;
  expect(harness.calls).toEqual([
    { command: "fetch", distro: "Ubuntu" },
    { command: "pull", distro: "Ubuntu" },
  ]);
});

it("does not clear the new space's busy state when an older pull finishes", async () => {
  let fetched!: () => void;
  harness.fetch = new Promise<void>((resolve) => {
    fetched = resolve;
  });
  const old = useSourceControl("/project", true);
  const pending = old.runRemoteAction("pull");
  harness.env = { kind: "wsl", distro: "Debian" };
  harness.refIndex = 0;
  useSourceControl("/project", true);
  harness.setState.mockClear();
  fetched();
  await pending;
  expect(harness.setState).not.toHaveBeenCalled();
});
