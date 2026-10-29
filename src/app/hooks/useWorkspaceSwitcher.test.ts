import { beforeEach, expect, it, vi } from "vitest";
import type { EffectCallback } from "react";
import type { WorkspaceEnv } from "@/modules/workspace/env";

const mock = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  values: [] as unknown[],
  stateIndex: 0,
  home: vi.fn(),
  cwd: vi.fn(),
  wslHome: vi.fn(),
  authorize: vi.fn(),
  spaces: {
    spaces: [],
    activeId: "local",
    create: vi.fn(),
    setActive: vi.fn(),
  },
}));
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useRef: (current: unknown) => ({ current }),
  useEffect: (fn: EffectCallback) => mock.effects.push(fn),
  useState: (initial: unknown) => {
    const index = mock.stateIndex++;
    mock.values[index] = initial;
    return [
      initial,
      (value: unknown) => {
        mock.values[index] = value;
      },
    ];
  },
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: mock.home }));
vi.mock("@/modules/ai/lib/native", () => ({
  native: { workspaceCurrentDir: mock.cwd },
}));
vi.mock("@/modules/spaces", () => ({
  useSpaces: { getState: () => mock.spaces },
}));
vi.mock("@/modules/workspace", () => ({
  LOCAL_WORKSPACE: { kind: "local" },
  workspaceScopeKey: (env: WorkspaceEnv) =>
    env.kind === "local" ? "local" : `wsl:${env.distro}`,
  authorizeRoot: mock.authorize,
  getWslHome: mock.wslHome,
}));
import { useWorkspaceSwitcher } from "./useWorkspaceSwitcher";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const ubuntu: WorkspaceEnv = { kind: "wsl", distro: "Ubuntu" };
const debian: WorkspaceEnv = { kind: "wsl", distro: "Debian" };
const params = () => ({
  setWorkspaceEnv: vi.fn(),
  newTab: vi.fn(() => 1),
  setActiveSpaceForNewTabs: vi.fn(),
});
beforeEach(() => {
  vi.clearAllMocks();
  mock.effects = [];
  mock.values = [];
  mock.stateIndex = 0;
  mock.authorize.mockResolvedValue(true);
});
it("does not publish an older distribution's home after a newer switch", async () => {
  const first = deferred<string>(),
    second = deferred<string>();
  mock.wslHome.mockImplementation((distro: string) =>
    distro === "Ubuntu" ? first.promise : second.promise,
  );
  const api = useWorkspaceSwitcher(params());
  const old = api.adoptWorkspaceEnv(ubuntu),
    current = api.adoptWorkspaceEnv(debian);
  second.resolve("/home/debian");
  await current;
  first.resolve("/home/ubuntu");
  await old;
  expect(mock.values.slice(0, 2)).toEqual(["/home/debian", "/home/debian"]);
  expect(mock.authorize).toHaveBeenCalledExactlyOnceWith(
    "/home/debian",
    debian,
  );
});
it("does not publish an old home if navigation happens during authorization", async () => {
  const authorized = deferred<boolean>();
  mock.wslHome.mockImplementation(async (distro: string) => `/home/${distro}`);
  mock.authorize.mockImplementation((path: string) =>
    path === "/home/Ubuntu" ? authorized.promise : Promise.resolve(true),
  );
  const api = useWorkspaceSwitcher(params());
  const old = api.adoptWorkspaceEnv(ubuntu);
  await vi.waitFor(() => expect(mock.authorize).toHaveBeenCalled());
  await api.adoptWorkspaceEnv(debian);
  authorized.resolve(true);
  expect(await old).toBeNull();
  expect(mock.values.slice(0, 2)).toEqual(["/home/Debian", "/home/Debian"]);
});
it("late local startup lookups cannot overwrite an adopted WSL environment", async () => {
  const home = deferred<string>(),
    cwd = deferred<string>();
  mock.home.mockReturnValue(home.promise);
  mock.cwd.mockReturnValue(cwd.promise);
  mock.wslHome.mockResolvedValue("/home/wsl");
  const api = useWorkspaceSwitcher(params());
  for (const effect of mock.effects) effect();
  await api.adoptWorkspaceEnv(ubuntu);
  home.resolve("C:/Users/me");
  cwd.resolve("C:/repo");
  await vi.waitFor(() => expect(mock.values[2]).toBe(true));
  expect(mock.values.slice(0, 2)).toEqual(["/home/wsl", "/home/wsl"]);
  expect(mock.authorize).toHaveBeenCalledExactlyOnceWith("/home/wsl", ubuntu);
});

it("clears previous paths while a new environment is unresolved or fails", async () => {
  mock.wslHome.mockResolvedValueOnce("/home/Ubuntu");
  const api = useWorkspaceSwitcher(params());
  await api.adoptWorkspaceEnv(ubuntu);
  mock.wslHome.mockRejectedValueOnce(new Error("distribution unavailable"));
  const pending = api.adoptWorkspaceEnv(debian);
  expect(mock.values.slice(0, 2)).toEqual([null, null]);
  expect(await pending).toBeNull();
  expect(mock.values.slice(0, 2)).toEqual([null, null]);
});
it("does not activate a new space after a later navigation supersedes its lookup", async () => {
  const home = deferred<string>();
  mock.wslHome
    .mockReturnValueOnce(home.promise)
    .mockResolvedValueOnce("/home/Debian");
  const inputs = params();
  const api = useWorkspaceSwitcher(inputs);
  const old = api.switchWorkspace(ubuntu);
  await api.adoptWorkspaceEnv(debian);
  home.resolve("/home/Ubuntu");
  await old;
  expect(mock.spaces.create).not.toHaveBeenCalled();
  expect(inputs.newTab).not.toHaveBeenCalled();
});
it("does not publish a home after its window unmounts", async () => {
  mock.home.mockResolvedValue("/local");
  mock.cwd.mockResolvedValue("/repo");
  const home = deferred<string>();
  mock.wslHome.mockReturnValue(home.promise);
  const api = useWorkspaceSwitcher(params());
  const dispose = mock.effects.map((effect) => effect());
  const pending = api.adoptWorkspaceEnv(ubuntu);
  for (const cleanup of dispose) cleanup?.();
  home.resolve("/home/Ubuntu");
  expect(await pending).toBeNull();
  expect(mock.authorize).not.toHaveBeenCalled();
});

it("selecting the current environment does not invalidate its pending home adoption", async () => {
  const home = deferred<string>();
  mock.home.mockReturnValue(home.promise);
  const api = useWorkspaceSwitcher(params());
  const adopting = api.adoptWorkspaceEnv({ kind: "local" });
  await api.switchWorkspace({ kind: "local" });
  home.resolve("/home/local");
  expect(await adopting).toBe("/home/local");
  expect(mock.values.slice(0, 2)).toEqual(["/home/local", "/home/local"]);
});
