import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  stop: vi.fn(),
  event: undefined as
    | undefined
    | ((event: {
        payload: { revision: number; changes: Record<string, unknown> };
      }) => void),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: fake.listen }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const emit = (revision: number, changes: Record<string, unknown>) =>
  fake.event?.({ payload: { revision, changes } });
beforeEach(() => {
  vi.resetModules();
  fake.invoke.mockReset().mockResolvedValue({
    revision: 0,
    values: { sttProvider: "groq", aiAllFolders: false },
  });
  fake.stop.mockClear();
  fake.listen.mockReset().mockImplementation(async (_name, cb) => {
    fake.event = cb;
    return fake.stop;
  });
});
it("late events cannot restore OpenAI or re-enable revoked folder access", async () => {
  const api = await import("./nativePreferences");
  const changed = vi.fn(),
    failed = vi.fn();
  const stop = await api.watchNativePreferences(changed, failed);
  emit(1, { sttProvider: "openai", aiAllFolders: true });
  emit(2, { sttProvider: "whispercpp", aiAllFolders: false });
  const count = changed.mock.calls.length;
  emit(1, { sttProvider: "openai", aiAllFolders: true });
  expect(changed).toHaveBeenLastCalledWith({
    revision: 2,
    values: { sttProvider: "whispercpp", aiAllFolders: false },
  });
  expect(changed).toHaveBeenCalledTimes(count);
  expect(fake.invoke).toHaveBeenCalledTimes(1); // ordinary deltas need no read
  stop();
  expect(fake.stop).toHaveBeenCalledOnce();
});
it("subscribes before reading and never publishes a snapshot older than an observed event", async () => {
  const first = deferred<{ revision: number; values: object }>();
  fake.invoke
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue({ revision: 2, values: { sttProvider: "whispercpp" } });
  const api = await import("./nativePreferences");
  const changed = vi.fn();
  const watching = api.watchNativePreferences(changed, vi.fn());
  await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalledOnce());
  expect(fake.listen).toHaveBeenCalledOnce();
  emit(2, { sttProvider: "whispercpp" });
  first.resolve({ revision: 0, values: { sttProvider: "openai" } });
  const stop = await watching;
  expect(
    changed.mock.calls.every(([snapshot]) => snapshot.revision === 2),
  ).toBe(true);
  expect(fake.invoke).toHaveBeenCalledTimes(2);
  stop();
});
it("missed revisions recover once without replaying intermediate stale changes", async () => {
  const api = await import("./nativePreferences");
  const changed = vi.fn();
  const stop = await api.watchNativePreferences(changed, vi.fn());
  const recovery = deferred<{ revision: number; values: object }>();
  fake.invoke.mockReturnValueOnce(recovery.promise);
  changed.mockClear();
  emit(3, { sttProvider: "whispercpp" });
  emit(1, { sttProvider: "openai" });
  emit(2, { aiAllFolders: true });
  expect(changed).not.toHaveBeenCalled();
  recovery.resolve({
    revision: 3,
    values: { sttProvider: "whispercpp", aiAllFolders: false },
  });
  await api.readNativePreferences();
  expect(changed).toHaveBeenCalledOnce();
  stop();
});
it("a delayed mutation response cannot rewind a newer native event", async () => {
  const api = await import("./nativePreferences");
  const changed = vi.fn();
  const stop = await api.watchNativePreferences(changed, vi.fn());
  const first = deferred<{ revision: number; changes: object }>();
  fake.invoke.mockReturnValueOnce(first.promise);
  const save = api.mutatePreferences({
    kind: "set",
    key: "sttProvider",
    value: "openai",
  });
  emit(1, { sttProvider: "openai" });
  emit(2, { sttProvider: "whispercpp" });
  first.resolve({ revision: 1, changes: { sttProvider: "openai" } });
  await save;
  expect(changed.mock.lastCall?.[0].values.sttProvider).toBe("whispercpp");
  stop();
});
it.each(["listen", "snapshot"])(
  "%s failure cleans up and permits a clean retry",
  async (phase) => {
    if (phase === "listen")
      fake.listen.mockRejectedValueOnce(new Error("failed"));
    else fake.invoke.mockRejectedValueOnce(new Error("failed"));
    const api = await import("./nativePreferences");
    await expect(api.watchNativePreferences(vi.fn(), vi.fn())).rejects.toThrow(
      "failed",
    );
    const changed = vi.fn();
    const stop = await api.watchNativePreferences(changed, vi.fn());
    expect(changed.mock.lastCall?.[0].revision).toBe(0);
    stop();
  },
);
it("a failed recovery preserves the last snapshot and reports the failure until retry", async () => {
  const api = await import("./nativePreferences");
  const changed = vi.fn(),
    failed = vi.fn();
  const stop = await api.watchNativePreferences(changed, failed);
  fake.invoke.mockRejectedValueOnce(new Error("disk read failed"));
  emit(2, { sttProvider: "whispercpp" });
  await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
  expect(changed.mock.lastCall?.[0].revision).toBe(0);
  fake.invoke.mockResolvedValueOnce({
    revision: 2,
    values: { sttProvider: "whispercpp" },
  });
  await api.readNativePreferences();
  expect(changed.mock.lastCall?.[0].revision).toBe(2);
  stop();
});
it("reconnecting reads changes made while no observer was attached", async () => {
  const api = await import("./nativePreferences");
  const stop = await api.watchNativePreferences(vi.fn(), vi.fn());
  stop();
  fake.invoke.mockResolvedValueOnce({
    revision: 5,
    values: { sttProvider: "whispercpp" },
  });
  const changed = vi.fn();
  const again = await api.watchNativePreferences(changed, vi.fn());
  expect(changed.mock.lastCall?.[0].revision).toBe(5);
  again();
});
it("failed writes do not publish speculative values", async () => {
  const api = await import("./nativePreferences");
  const changed = vi.fn();
  const stop = await api.watchNativePreferences(changed, vi.fn());
  changed.mockClear();
  fake.invoke.mockRejectedValueOnce(new Error("read-only disk"));
  await expect(
    api.mutatePreferences({ kind: "set", key: "aiAllFolders", value: true }),
  ).rejects.toThrow("read-only disk");
  expect(changed).not.toHaveBeenCalled();
  stop();
});
it("reconnecting does not reuse a snapshot requested before the listener disconnected", async () => {
  const api = await import("./nativePreferences");
  const stop = await api.watchNativePreferences(vi.fn(), vi.fn());
  const old = deferred<{ revision: number; values: object }>();
  fake.invoke.mockReturnValueOnce(old.promise);
  emit(2, { sttProvider: "openai" });
  stop();
  // Revision 3 happened while no listener existed; only a new read can see it.
  fake.invoke.mockResolvedValueOnce({
    revision: 3,
    values: { sttProvider: "whispercpp" },
  });
  const changed = vi.fn();
  const watching = api.watchNativePreferences(changed, vi.fn());
  await new Promise((resolve) => setTimeout(resolve, 0));
  old.resolve({ revision: 2, values: { sttProvider: "openai" } });
  const stopAgain = await watching;
  expect(changed.mock.lastCall?.[0]).toEqual({
    revision: 3,
    values: { sttProvider: "whispercpp" },
  });
  stopAgain();
});
it("an obsolete read cannot report failure to a new connection or clear its pending read", async () => {
  const api = await import("./nativePreferences");
  const stop = await api.watchNativePreferences(vi.fn(), vi.fn());
  const old = deferred<{ revision: number; values: object }>();
  fake.invoke.mockReturnValueOnce(old.promise);
  emit(2, {});
  stop();
  const fresh = deferred<{ revision: number; values: object }>();
  fake.invoke.mockReturnValueOnce(fresh.promise);
  const changed = vi.fn(),
    failed = vi.fn();
  const watching = api.watchNativePreferences(changed, failed);
  await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalledTimes(3));
  old.reject(new Error("obsolete read failed"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(failed).not.toHaveBeenCalled();
  emit(3, { sttProvider: "whispercpp" });
  expect(fake.invoke).toHaveBeenCalledTimes(3);
  fresh.resolve({ revision: 3, values: { sttProvider: "whispercpp" } });
  const stopAgain = await watching;
  expect(changed.mock.lastCall?.[0].revision).toBe(3);
  stopAgain();
});
