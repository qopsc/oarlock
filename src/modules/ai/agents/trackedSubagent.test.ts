import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  ready: true,
  stop: true,
  commands: [] as Record<string, unknown>[],
  controllers: new Map<string, AbortController>(),
  run: vi.fn(),
  command: vi.fn(),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({
      hydrated: state.ready,
      error: null,
      syncing: false,
      aiStopSubagents: state.stop,
    }),
  },
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("./runSubagent", () => ({ runSubagent: state.run }));
vi.mock("../store/subagentTasks", () => ({
  initializeTasks: async () => {},
  taskOwner: async () => 3,
  taskCommand: (r: Record<string, unknown>) => {
    state.commands.push(r);
    return state.command(r);
  },
  registerTask: (id: string, c: AbortController) => {
    state.controllers.set(id, c);
    return () => state.controllers.delete(id);
  },
}));
import { runTrackedSubagent } from "./trackedSubagent";
const args = {
  sessionId: "chat",
  title: "Review",
  type: "code-review",
  prompt: "review",
  modelId: "model",
  keys: {},
  config: {},
  toolContext: {},
} as unknown as Parameters<typeof runTrackedSubagent>[0];
function deferred<T>() {
  let resolve!: (t: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
beforeEach(() => {
  state.ready = true;
  state.stop = true;
  state.commands = [];
  state.controllers.clear();
  state.run.mockReset();
  state.command.mockReset();
  state.command.mockResolvedValue(undefined);
});
it("keeps the result and usage when its parent stops with cancellation disabled", async () => {
  state.stop = false;
  const entered = deferred<void>(),
    finish = deferred<void>();
  const parent = new AbortController();
  state.run.mockImplementation(async (a) => {
    entered.resolve();
    await finish.promise;
    expect(a.abortSignal.aborted).toBe(false);
    a.onUsage("model", { inputTokens: 12, outputTokens: 5 });
    a.onStep("done");
    return { summary: "independent result", stepCount: 1, durationMs: 1 };
  });
  const onStep = vi.fn();
  const running = runTrackedSubagent({
    ...args,
    abortSignal: parent.signal,
    onStep,
  });
  await entered.promise;
  parent.abort();
  finish.resolve();
  await running;
  expect(onStep).not.toHaveBeenCalled();
  expect(state.commands[state.commands.length - 1]).toMatchObject({
    status: "completed",
    result: "independent result",
    inputTokens: 12,
    outputTokens: 5,
  });
  expect(state.controllers.size).toBe(0);
});
it("cancels the child with the parent by default and records cancellation", async () => {
  const entered = deferred<void>();
  const parent = new AbortController();
  state.run.mockImplementation(
    (a) =>
      new Promise((_resolve, reject) => {
        a.abortSignal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
        entered.resolve();
      }),
  );
  const running = runTrackedSubagent({ ...args, abortSignal: parent.signal });
  const rejected = expect(running).rejects.toThrow("aborted");
  await entered.promise;
  parent.abort();
  await rejected;
  expect(state.commands[state.commands.length - 1]).toMatchObject({
    status: "cancelled",
  });
});
it("manual cancellation works even when the parent setting is off", async () => {
  state.stop = false;
  const entered = deferred<void>();
  state.run.mockImplementation(
    (a) =>
      new Promise((_resolve, reject) => {
        a.abortSignal.addEventListener("abort", () =>
          reject(new Error("manual")),
        );
        entered.resolve();
      }),
  );
  const running = runTrackedSubagent(args);
  const rejected = expect(running).rejects.toThrow("manual");
  await entered.promise;
  for (const controller of state.controllers.values()) controller.abort();
  await rejected;
  expect(state.commands[state.commands.length - 1]).toMatchObject({
    status: "cancelled",
  });
});
it("serializes step writes before the final result", async () => {
  const step = deferred<void>();
  state.command.mockImplementation((r) =>
    r.status === "running" ? step.promise : Promise.resolve(),
  );
  state.run.mockImplementation(async (a) => {
    a.onStep("reading");
    return { summary: "result", stepCount: 1, durationMs: 1 };
  });
  const running = runTrackedSubagent(args);
  await vi.waitFor(() =>
    expect(state.commands.some((r) => r.status === "running")).toBe(true),
  );
  expect(state.commands.some((r) => r.status === "completed")).toBe(false);
  step.resolve();
  await running;
  expect(state.commands[state.commands.length - 1]).toMatchObject({
    status: "completed",
    result: "result",
  });
});
it("does not start paid work after cancellation during native registration", async () => {
  const start = deferred<void>();
  const parent = new AbortController();
  state.command.mockImplementation((r) =>
    r.action === "start" ? start.promise : Promise.resolve(),
  );
  const running = runTrackedSubagent({ ...args, abortSignal: parent.signal });
  const rejected = expect(running).rejects.toThrow();
  await vi.waitFor(() => expect(state.commands.length).toBe(1));
  parent.abort();
  start.resolve();
  await rejected;
  expect(state.run).not.toHaveBeenCalled();
  expect(state.commands[state.commands.length - 1]).toMatchObject({
    status: "cancelled",
  });
});
it("refuses to start a tracked subagent before preferences recover", async () => {
  state.ready = false;
  await expect(runTrackedSubagent(args)).rejects.toThrow("Preferences");
  expect(state.commands).toEqual([]);
  expect(state.run).not.toHaveBeenCalled();
});
it("retries a final result that could not be saved, so Stop is not left waiting on a running record", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    toastError.mockClear();
    let failures = 2;
    state.command.mockImplementation(async (r) => {
      if (r.status === "completed" && failures-- > 0) throw new Error("ipc");
    });
    state.run.mockResolvedValue({
      summary: "done",
      stepCount: 1,
      durationMs: 1,
    });
    const running = runTrackedSubagent(args);
    await vi.advanceTimersByTimeAsync(5_000);
    await running;
    expect(state.commands.filter((r) => r.status === "completed")).toHaveLength(
      3,
    );
    expect(toastError).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it("reports a final result that still cannot be saved after the retries", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    toastError.mockClear();
    state.command.mockImplementation(async (r) => {
      if (r.status === "completed") throw new Error("ipc down");
    });
    state.run.mockResolvedValue({
      summary: "done",
      stepCount: 1,
      durationMs: 1,
    });
    const running = runTrackedSubagent(args);
    await vi.advanceTimersByTimeAsync(5_000);
    await running;
    expect(state.commands.filter((r) => r.status === "completed")).toHaveLength(
      3,
    );
    expect(toastError).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
