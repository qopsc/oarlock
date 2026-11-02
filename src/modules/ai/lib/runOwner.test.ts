import { beforeEach, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() =>
  vi.fn<(command: string, args?: unknown) => Promise<unknown>>(
    async () => undefined,
  ),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  beginRun,
  chatHasRuns,
  claimRun,
  closeChatRuns,
  takePaused,
  trackWork,
} from "./runOwner";

const ended = () =>
  invokeMock.mock.calls
    .filter(([command]) => command === "ai_run_end")
    .map(([, args]) => (args as { runId: string }).runId);
const user = (id: string) => [{ id, role: "user" }];

function stalledStream() {
  const state = { cancelled: false };
  const source = new ReadableStream<string>({
    cancel() {
      state.cancelled = true;
    },
  });
  return { source, state };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => undefined);
});

it("stop releases the stream, the native record and pending preparation", async () => {
  const turn = beginRun("c1", { kind: "turn", admit: async () => {} });
  const { source, state } = stalledStream();
  turn.wrapStream(source);
  const preparation = beginRun("c1", { kind: "prepare" });
  const prepared = vi.fn();
  preparation.onPrepared(prepared);
  turn.setupDone();

  await closeChatRuns("c1", "stop");

  expect(state.cancelled).toBe(true);
  expect(ended()).toEqual([turn.runId]);
  expect(preparation.signal.aborted).toBe(true);
  expect(prepared).toHaveBeenCalledOnce();
  expect(chatHasRuns("c1")).toBe(false);
});

it("a failed release stays reachable and a retry releases only what is left", async () => {
  const turn = beginRun("c2", { kind: "turn", admit: async () => {} });
  const { source, state } = stalledStream();
  turn.wrapStream(source);
  turn.setupDone();
  invokeMock.mockRejectedValue(new Error("IPC failed"));
  vi.spyOn(console, "warn").mockImplementation(() => {});

  await expect(closeChatRuns("c2", "stop")).rejects.toThrow("IPC failed");
  expect(chatHasRuns("c2")).toBe(true);
  expect(state.cancelled).toBe(true);

  invokeMock.mockImplementation(async () => undefined);
  const attempts = ended().length;
  await closeChatRuns("c2", "stop");
  expect(ended()).toHaveLength(attempts + 1);
  expect(chatHasRuns("c2")).toBe(false);
});

it("stop waits for tool work and a turn that is still starting before it releases", async () => {
  const finishWork = trackWork("c3");
  const turn = beginRun("c3", { kind: "turn", admit: async () => {} });
  let settled = false;
  const stopping = closeChatRuns("c3", "stop").then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(ended()).toEqual([]);
  finishWork();
  turn.setupDone();
  await stopping;
  expect(ended()).toEqual([turn.runId]);
});

it("accepting a message drops the preparation watchers and a later navigation cannot cancel the turn", () => {
  const owner = beginRun("c4", { kind: "prepare" });
  const watcher = vi.fn();
  owner.onPrepared(watcher);
  owner.accept("u1");
  expect(watcher).toHaveBeenCalledOnce();
  const claimed = claimRun("c4", user("u1"));
  expect(claimed).toBe(owner);
  expect(owner.phase).toBe("running");
  expect(owner.signal.aborted).toBe(false);
  owner.abandon();
  expect(owner.phase).toBe("running");
});

it("a continuation or regenerate cannot take a composer owner", () => {
  const owner = beginRun("c5", { kind: "prepare" });
  owner.accept("u1");
  expect(claimRun("c5", user("other"))).toBeUndefined();
  expect(claimRun("c5", [{ id: "a1", role: "assistant" }])).toBeUndefined();
  expect(owner.phase).toBe("accepted");
  expect(claimRun("c5", user("u1"))).toBe(owner);
});

it("a stopped accepted owner is not replaced by a fresh one for the same message", async () => {
  const owner = beginRun("c6", { kind: "prepare" });
  owner.accept("u1");
  await closeChatRuns("c6", "stop");
  expect(() => claimRun("c6", user("u1"))).toThrow("stopped");
  expect(claimRun("c6", user("u2"))).toBeUndefined();
});

it("an accepted owner nothing claims is abandoned", async () => {
  const owner = beginRun("c7", { kind: "prepare", admit: async () => {} });
  owner.accept("u1");
  owner.abandon();
  await vi.waitFor(() => expect(ended()).toEqual([owner.runId]));
  expect(chatHasRuns("c7")).toBe(false);
});

it("cancelling preparation releases its record and leaves a running turn alone", async () => {
  const turn = beginRun("c8", { kind: "turn", admit: async () => {} });
  turn.setupDone();
  const preparation = beginRun("c8", {
    kind: "prepare",
    admit: async () => {},
  });
  preparation.cancel("navigated");
  await vi.waitFor(() => expect(ended()).toEqual([preparation.runId]));
  expect(turn.signal.aborted).toBe(false);
  expect(turn.phase).toBe("running");
});

it("a stream that ends with an approval pending pauses the owner and a continuation takes it", async () => {
  const turn = beginRun("c9", { kind: "turn", admit: async () => {} });
  const stream = turn.wrapStream(
    new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: "tool-approval-request",
          toolCallId: "call",
        });
        controller.close();
      },
    }),
  );
  const reader = stream.getReader();
  while (!(await reader.read()).done);
  expect(turn.phase).toBe("paused");
  expect(ended()).toEqual([]);
  expect(chatHasRuns("c9")).toBe(true);
  const previous = takePaused("c9");
  expect(previous).toBe(turn);
  await previous?.close("continued");
  expect(ended()).toEqual([turn.runId]);
});

it("a stream that errors after requesting approval is not kept", async () => {
  const turn = beginRun("c10", { kind: "turn", admit: async () => {} });
  const stream = turn.wrapStream(
    new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "tool-approval-request", toolCallId: "c" });
        controller.enqueue({ type: "error" });
        controller.close();
      },
    }),
  );
  const reader = stream.getReader();
  while (!(await reader.read()).done);
  expect(turn.phase).toBe("closed");
  expect(ended()).toEqual([turn.runId]);
});

it("the SDK's abort signal releases a stalled run once", async () => {
  const controller = new AbortController();
  const turn = beginRun("c11", { kind: "turn", admit: async () => {} });
  const { source } = stalledStream();
  const stream = turn.wrapStream(source, { signal: controller.signal });
  controller.abort();
  await vi.waitFor(() => expect(ended()).toEqual([turn.runId]));
  await stream.cancel();
  expect(ended()).toEqual([turn.runId]);
});

it("an admission that is refused still closes the owner's native record", async () => {
  const owner = beginRun("c12", {
    kind: "turn",
    admit: async () => {
      throw new Error("stopping");
    },
  });
  await expect(owner.ready).rejects.toThrow("stopping");
  await owner.close("error");
  expect(ended()).toEqual([owner.runId]);
});

it("a release failure on a normal completion does not turn the finished reply into an error", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const turn = beginRun("c14", { kind: "turn", admit: async () => {} });
  invokeMock.mockRejectedValueOnce(new Error("IPC failed"));
  turn.setupDone();
  const stream = turn.wrapStream(
    new ReadableStream({
      start(controller) {
        controller.enqueue("answer");
        controller.close();
      },
    }),
  );
  const reader = stream.getReader();
  expect((await reader.read()).value).toBe("answer");
  expect((await reader.read()).done).toBe(true);
  expect(chatHasRuns("c14")).toBe(true);
  await closeChatRuns("c14", "stop");
  expect(chatHasRuns("c14")).toBe(false);
});
it("an abandoned accepted owner does not block a retry of the same message", async () => {
  const owner = beginRun("c13", { kind: "prepare" });
  owner.accept("u1");
  owner.abandon();
  await vi.waitFor(() => expect(owner.phase).toBe("closed"));
  expect(claimRun("c13", user("u1"))).toBeUndefined();
});
