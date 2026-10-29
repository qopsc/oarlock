import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as manager from "./sessionManager";

const mocks = vi.hoisted(() => {
  let finish: () => void = () => {};
  let gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const start = vi.fn(() => gate);
  const close = vi.fn();
  const preset = {
    id: "test",
    name: "Test",
    command: "test-lsp",
    args: [],
    languages: { test: "test" },
  };
  const preferences = {
    lspCustomServers: [] as { id: string; command: string }[],
    lspActivation: { test: "enabled" },
  };
  return {
    start,
    close,
    ready: true,
    transports: [] as {
      exitInfo: { code: null; stderrTail: string; reason: string } | null;
    }[],
    clients: [] as { onClose: () => void }[],
    listener: null as
      | null
      | ((state: typeof preferences, prev: typeof preferences) => void),
    preset,
    reset() {
      gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    finish() {
      finish();
    },
    preferences,
  };
});
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => mocks.preferences,
    subscribe: (listener: typeof mocks.listener) => {
      mocks.listener = listener;
    },
  },
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));
vi.mock("./detect", () => ({ detectBinary: async () => "/bin/test-lsp" }));
vi.mock("./presets", () => ({
  serverForLanguage: () => mocks.preset,
  rootMarkersOf: () => ["marker"],
}));
vi.mock("./navigator", () => ({ getLspNavigator: () => null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: { path: string }) =>
    command === "lsp_host_pid" ? 1 : args?.path.replace(/\/file$/, ""),
}));
vi.mock("./transport", () => ({
  retireLspGeneration: vi.fn(async () => {}),
  TauriLspTransport: class {
    constructor() {
      mocks.transports.push(this);
    }
    start = mocks.start;
    close = mocks.close;
    exitInfo = null;
  },
}));
vi.mock("./client", () => ({
  OarlockLspClient: class {
    static hostPid = 1;
    constructor(options: { onClose: () => void }) {
      mocks.clients.push(options);
    }
    close() {
      mocks.close();
    }
    ready = mocks.ready;
    initializePromise = Promise.resolve();
    textDocumentDidClose() {}
    async shutdownGracefully() {}
  },
  lspInteractions: () => [],
  languageServerWithTransport: () => [],
  SynchronizationMethod: { Incremental: 2 },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reset();
  mocks.clients.length = 0;
});
afterEach(() => {
  mocks.finish();
});

it("counts in-flight starts toward the existing per-preset session limit", async () => {
  const requests: ReturnType<typeof manager.acquireDocExtension>[] = [];
  for (let i = 0; i < 4; i++) {
    requests.push(manager.acquireDocExtension(`/repo${i}/file`, "test"));
    await vi.waitFor(() => expect(mocks.start.mock.calls.length).toBe(i + 1));
  }
  const overflow = manager.acquireDocExtension("/repo4/file", "test");
  const refusedWhileStarting = await Promise.race([
    overflow.then((handle) => handle === null),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  requests.push(overflow);
  // Same-root acquisition should share its reservation even when the cap is full.
  const shared = manager.acquireDocExtension("/repo0/file", "test");
  mocks.finish();
  const handles = await Promise.all(requests);
  const duplicate = await shared;
  const started = mocks.start.mock.calls.length;
  const admitted = handles.filter(Boolean).length;
  for (const handle of handles) handle?.release();
  duplicate?.release();
  await manager.restartPresetSessions("test");
  expect(started).toBe(4);
  expect(refusedWhileStarting).toBe(true);
  expect(admitted).toBe(4);
  expect(duplicate).not.toBeNull();
});

it("disabling a language server while it starts cannot attach it afterwards", async () => {
  mocks.preferences.lspActivation.test = "enabled";
  const pending = manager.acquireDocExtension("/disable/file", "test");
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
  mocks.preferences.lspActivation.test = "disabled";
  mocks.finish();
  const handle = await pending;
  const closed = mocks.close.mock.calls.length;
  handle?.release();
  await manager.restartPresetSessions("test");
  mocks.preferences.lspActivation.test = "enabled";
  expect(handle).toBeNull();
  expect(closed).toBe(1);
});

it("restart invalidates a pending start and allows a fresh session", async () => {
  const old = manager.acquireDocExtension("/restart/file", "test");
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
  await manager.restartPresetSessions("test");
  const fresh = manager.acquireDocExtension("/restart/file", "test");
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
  mocks.finish();
  expect(await old).toBeNull();
  const handle = await fresh;
  expect(handle).not.toBeNull();
  handle?.release();
  await manager.restartPresetSessions("test");
});

it("configuration edits invalidate pending starts before their replies", async () => {
  const pending = manager.acquireDocExtension("/configuration/file", "test");
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
  const prev = { ...mocks.preferences };
  mocks.preferences.lspCustomServers = [{ id: "test", command: "replacement" }];
  mocks.listener?.(mocks.preferences, prev);
  mocks.finish();
  expect(await pending).toBeNull();
  await manager.restartPresetSessions("test");
});

it("an old server exit cannot close its replacement", async () => {
  const first = manager.acquireDocExtension("/exit/file", "test");
  mocks.finish();
  const a = await first;
  const old = mocks.clients[mocks.clients.length - 1];
  await manager.restartPresetSessions("test");
  const b = await manager.acquireDocExtension("/exit/file", "test");
  old.onClose();
  const c = await manager.acquireDocExtension("/exit/file", "test");
  expect(mocks.start).toHaveBeenCalledTimes(2);
  expect(b).not.toBeNull();
  expect(c).not.toBeNull();
  a?.release();
  b?.release();
  c?.release();
  await manager.restartPresetSessions("test");
});

it("does not leave a failed initialization marked running", async () => {
  const { useLspRuntimeStore } = await import("./runtimeStore");
  mocks.ready = false;
  const pending = manager.acquireDocExtension(
    "/initialize-failure/file",
    "test",
  );
  mocks.finish();
  const handle = await pending;
  await Promise.resolve();
  const running = Object.values(useLspRuntimeStore.getState().sessions).some(
    (s) => s.root === "/initialize-failure" && s.status === "running",
  );
  const closed = mocks.close.mock.calls.length;
  handle?.release();
  await manager.restartPresetSessions("test");
  mocks.ready = true;
  expect(running).toBe(false);
  expect(closed).toBeGreaterThan(0);
});

it("writer failure requires explicit Restart even after the crash window expires", async () => {
  const { useLspRuntimeStore } = await import("./runtimeStore");
  const pending = manager.acquireDocExtension("/blocked-writer/file", "test");
  mocks.finish();
  const handle = await pending;
  mocks.transports[mocks.transports.length - 1].exitInfo = {
    code: null,
    stderrTail: "",
    reason: "Write stalled; Restart required",
  };
  mocks.clients[mocks.clients.length - 1].onClose();
  expect(useLspRuntimeStore.getState().failed.test).toContain("Write stalled");
  const otherRoot = await manager.acquireDocExtension(
    "/healthy-writer/file",
    "test",
  );
  expect(otherRoot).not.toBeNull();
  expect(useLspRuntimeStore.getState().failed.test).toContain("Write stalled");
  otherRoot?.release();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
  try {
    expect(
      await manager.acquireDocExtension("/blocked-writer/file", "test"),
    ).toBeNull();
  } finally {
    clock.mockRestore();
  }
  await manager.restartPresetSessions("test");
  expect(useLspRuntimeStore.getState().failed.test).toBeUndefined();
  const fresh = await manager.acquireDocExtension(
    "/blocked-writer/file",
    "test",
  );
  expect(fresh).not.toBeNull();
  handle?.release();
  fresh?.release();
  await manager.restartPresetSessions("test");
});
