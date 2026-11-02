import { beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  refs: [] as { current: unknown }[], refIndex: 0, fetch: vi.fn(), setState: vi.fn(),
  state: {
    contextPath: "/repo", hasRepo: true, isLoading: false, localError: null,
    busyAction: null, lastRemoteError: null,
    repo: { repoRoot: "/repo", branch: "main", upstream: "origin/main", isDetached: false, linkedWorktree: null },
    status: { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, changedFiles: [] },
  },
}));
vi.mock("react", async (actual) => ({
  ...(await actual<typeof import("react")>()),
  useState: () => [harness.state, harness.setState],
  useRef: (value: unknown) => { const i = harness.refIndex++; harness.refs[i] ??= { current: value }; return harness.refs[i]; },
  useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn, useEffect: () => {},
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
  useWorkspaceEnvStore: (select: (state: unknown) => unknown) => select({ env: { kind: "local" } }),
}));
vi.mock("@/modules/ai/lib/native", () => {
  const createNative = () => ({
    gitFetch: harness.fetch,
    gitPanelSnapshot: async () => ({ repo: harness.state.repo, status: harness.state.status }),
    gitStatus: async () => harness.state.status,
  });
  return { native: createNative(), createNative };
});
vi.mock("@/modules/editor/lib/gitSignals", () => ({ notifyHeadMoved: vi.fn() }));
import { useSourceControl } from "./useSourceControl";

beforeEach(() => {
  harness.refs.length = 0; harness.refIndex = 0; harness.fetch.mockReset(); harness.setState.mockClear();
});

it("refuses a second remote action until the first has finished", async () => {
  let finish!: () => void;
  harness.fetch.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }))
    .mockResolvedValue(undefined);
  const source = useSourceControl("/repo", true);
  const first = source.runRemoteAction("fetch");
  expect(await source.runRemoteAction("fetch")).toMatchObject({ ok: false, blocked: "busy" });
  expect(harness.fetch).toHaveBeenCalledTimes(1);
  finish();
  expect((await first).ok).toBe(true);
  expect((await source.runRemoteAction("fetch")).ok).toBe(true);
  expect(harness.fetch).toHaveBeenCalledTimes(2);
});
