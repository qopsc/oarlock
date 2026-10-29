import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  stop: vi.fn(),
  endpointStop: vi.fn(),
  event: undefined as
    | undefined
    | ((event: {
        payload: { revision: number; changes: Record<string, unknown> };
      }) => void),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: fake.invoke,
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: fake.listen }));
vi.mock("./endpoints", () => ({
  onCustomEndpoints: async (changed: (value: []) => void) => {
    changed([]);
    return fake.endpointStop;
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));
beforeEach(() => {
  vi.resetModules();
  fake.stop.mockClear();
  fake.endpointStop.mockClear();
  fake.listen.mockReset().mockImplementation(async (_name, cb) => {
    fake.event = cb;
    return fake.stop;
  });
  fake.invoke.mockReset().mockResolvedValue({
    revision: 1,
    values: { sttProvider: "whispercpp", appAllFolders: true },
  });
});
it("initialization waits for listening and hydration, then follows only newer revisions", async () => {
  const { usePreferencesStore: store } = await import("./preferences");
  await Promise.all([store.getState().init(), store.getState().init()]);
  expect(store.getState()).toMatchObject({
    hydrated: true,
    sttProvider: "whispercpp",
    appAllFolders: true,
  });
  expect(fake.listen).toHaveBeenCalledOnce();
  fake.event?.({ payload: { revision: 2, changes: { appAllFolders: false } } });
  fake.event?.({ payload: { revision: 1, changes: { appAllFolders: true } } });
  expect(store.getState().appAllFolders).toBe(false);
  expect(
    fake.invoke.mock.calls.every(
      ([command]) => command === "preferences_snapshot",
    ),
  ).toBe(true);
});
it("startup changes survive a delayed initial read", async () => {
  let resolve!: (value: unknown) => void;
  fake.invoke
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue({ revision: 2, values: { sttProvider: "whispercpp" } });
  const { usePreferencesStore: store } = await import("./preferences");
  const loading = store.getState().init();
  await vi.waitFor(() => expect(resolve).toBeDefined());
  fake.event?.({
    payload: { revision: 2, changes: { sttProvider: "whispercpp" } },
  });
  resolve({ revision: 1, values: { sttProvider: "openai" } });
  await loading;
  expect(store.getState().sttProvider).toBe("whispercpp");
});
it("failed startup preserves its error and cleans listeners before Retry", async () => {
  fake.invoke.mockRejectedValueOnce(new Error("damaged preferences"));
  const { usePreferencesStore: store } = await import("./preferences");
  await expect(store.getState().init()).rejects.toThrow("damaged preferences");
  const { toast } = await import("sonner");
  expect(toast.error).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({
      id: "preferences-recovery",
      duration: Infinity,
      action: expect.objectContaining({ label: "Retry" }),
    }),
  );
  expect(store.getState()).toMatchObject({
    hydrated: false,
    error: "Error: damaged preferences",
  });
  expect(fake.stop).toHaveBeenCalledOnce();
  expect(fake.endpointStop).toHaveBeenCalledOnce();
  await store.getState().init();
  expect(toast.dismiss).toHaveBeenCalledWith("preferences-recovery");
  expect(store.getState()).toMatchObject({
    hydrated: true,
    error: null,
    sttProvider: "whispercpp",
  });
});
it("unchanged fields keep their references and a delta publishes one store update", async () => {
  const { usePreferencesStore: store } = await import("./preferences");
  await store.getState().init();
  const behavior = store.getState().terminalBehavior;
  const changed = vi.fn();
  const stop = store.subscribe(changed);
  fake.event?.({ payload: { revision: 2, changes: { sttProvider: "groq" } } });
  expect(changed).toHaveBeenCalledOnce();
  expect(store.getState().terminalBehavior).toBe(behavior);
  stop();
});
it("failed recovery retains loaded UI state while its error blocks sensitive consumers", async () => {
  const { usePreferencesStore: store } = await import("./preferences");
  await store.getState().init();
  fake.invoke.mockRejectedValueOnce(new Error("read failed"));
  fake.event?.({
    payload: { revision: 3, changes: { sttProvider: "whispercpp" } },
  });
  await vi.waitFor(() =>
    expect(store.getState().error).toContain("read failed"),
  );
  // QuickTerminalApp uses hydration to keep its pane mounted. A sync error
  // must not remove it or restore the sidebar/background startup shadows.
  expect(store.getState().hydrated).toBe(true);
  expect(store.getState().error).toContain("read failed");
  // The resulting values can equal the old ones; recovery must still clear the error.
  fake.invoke.mockResolvedValueOnce({
    revision: 3,
    values: { sttProvider: "whispercpp", appAllFolders: true },
  });
  const { readNativePreferences } = await import("./nativePreferences");
  await readNativePreferences();
  expect(store.getState()).toMatchObject({ hydrated: true, error: null });
});
it("blocks execution immediately on a revision gap while retaining the loaded UI snapshot", async () => {
  const { usePreferencesStore: store } = await import("./preferences");
  const { preferencesReady } = await import("./readiness");
  await store.getState().init();
  let resolve!: (value: unknown) => void;
  fake.invoke.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  fake.event?.({ payload: { revision: 3, changes: { sttProvider: "groq" } } });
  expect(store.getState()).toMatchObject({
    hydrated: true,
    syncing: true,
    error: null,
    sttProvider: "whispercpp",
  });
  expect(preferencesReady(store.getState())).toBe(false);
  resolve({ revision: 3, values: { sttProvider: "groq" } });
  await vi.waitFor(() => expect(preferencesReady(store.getState())).toBe(true));
  expect(store.getState().sttProvider).toBe("groq");
});

it("Retry does not dismiss the recovery action while another read fails", async () => {
  const { usePreferencesStore: store } = await import("./preferences");
  const { toast } = await import("sonner");
  await store.getState().init();
  fake.invoke.mockRejectedValueOnce(new Error("read failed"));
  fake.event?.({ payload: { revision: 3, changes: {} } });
  await vi.waitFor(() =>
    expect(store.getState().error).toContain("read failed"),
  );
  const action = vi.mocked(toast.error).mock.lastCall?.[1]
    ?.action as unknown as {
    onClick: (event: { preventDefault: () => void }) => void;
  };
  const preventDefault = vi.fn();
  fake.invoke.mockRejectedValueOnce(new Error("still failed"));
  action.onClick({ preventDefault });
  await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalledTimes(3));
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(store.getState().error).not.toBeNull();
  fake.invoke.mockResolvedValueOnce({
    revision: 3,
    values: { sttProvider: "groq" },
  });
  action.onClick({ preventDefault });
  await vi.waitFor(() => expect(store.getState().error).toBeNull());
  expect(toast.dismiss).toHaveBeenCalledWith("preferences-recovery");
});
