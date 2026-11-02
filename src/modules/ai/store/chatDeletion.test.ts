import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  invoke: vi.fn(async (name: string, args?: unknown) => {
    if (name === "ai_chat_register")
      return {
        chatId: (args as { chatId: string }).chatId,
        revision: 1,
        blocked: false,
        error: null,
      };
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("../tools/shell", () => ({ settleShellClosures: async () => {} }));
vi.mock("../lib/todos", () => ({ deleteTodos: vi.fn(async () => {}) }));
vi.mock("../lib/native", () => ({ native: { shellBgKillChat: vi.fn() } }));
vi.mock("../lib/sessions", () => ({
  loadAll: vi.fn(),
  newSessionId: vi.fn(() => "fresh"),
  saveSessionsList: vi.fn(async () => {}),
  saveActiveId: vi.fn(async () => {}),
  onSessionsChanged: vi.fn(async () => () => {}),
  loadMessages: vi.fn(async () => null),
  deleteSessionData: vi.fn(),
  deriveTitle: vi.fn(),
  saveMessages: vi.fn(),
}));

const meta = (id: string) => ({ id, title: id, createdAt: 1, updatedAt: 1 });
const ended = () =>
  mock.invoke.mock.calls
    .filter(([name]) => name === "ai_run_end")
    .map(([, args]) => (args as { runId: string }).runId);

async function runningTurn(chatId: string) {
  const { beginRun } = await import("../lib/runOwner");
  const owner = beginRun(chatId, { kind: "turn", admit: async () => {} });
  let cancelled = false;
  const source = new ReadableStream<string>({
    cancel() {
      cancelled = true;
    },
  });
  owner.wrapStream(source);
  owner.setupDone();
  return { owner, cancelled: () => cancelled };
}

beforeEach(() => {
  mock.invoke.mockClear();
});

it("deleting a chat stops its run and releases its lease", async () => {
  const { useChatStore } = await import("./chatStore");
  useChatStore.setState({
    sessions: [meta("doomed"), meta("other")],
    activeSessionId: "other",
  });
  const turn = await runningTurn("doomed");
  useChatStore.getState().deleteSession("doomed");
  await vi.waitFor(() => expect(ended()).toEqual([turn.owner.runId]));
  expect(turn.cancelled()).toBe(true);
});

it("a deletion made in another window stops the local run too", async () => {
  const { useChatStore } = await import("./chatStore");
  useChatStore.setState({
    sessions: [meta("remote"), meta("kept")],
    activeSessionId: "kept",
  });
  const turn = await runningTurn("remote");
  useChatStore.getState().adoptSessionsList([meta("kept")]);
  await vi.waitFor(() => expect(ended()).toEqual([turn.owner.runId]));
  expect(turn.cancelled()).toBe(true);
});
