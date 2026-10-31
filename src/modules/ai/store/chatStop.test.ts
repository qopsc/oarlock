import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  invoke: vi.fn(),
  close: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  toast: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    mock.listeners.set(name, cb);
    return () => mock.listeners.delete(name);
  },
}));
vi.mock("sonner", () => ({ toast: { error: mock.toast } }));
vi.mock("../tools/shell", () => ({ settleShellClosures: mock.close }));
vi.mock("./chatStore", () => ({
  chats: new Map([["chat", { stop: mock.stop }]]),
}));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const options = { stopBackground: true, stopSubagents: true };
let status = {
  chatId: "chat",
  revision: 1,
  blocked: false,
  error: null as string | null,
};
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.listeners.clear();
  status = { chatId: "chat", revision: 1, blocked: false, error: null };
  mock.stop.mockResolvedValue();
  mock.close.mockResolvedValue();
  mock.invoke.mockImplementation(async (name: string) => {
    if (name === "ai_chat_register") return { ...status };
  });
});
it("blocks the next turn until SDK stop, pending starts, shell cleanup and native completion settle", async () => {
  const { stopChat, assertChatCanStart, useChatStop } = await import(
    "./chatStop"
  );
  const { beginChatWork } = await import("../lib/chatWork");
  await assertChatCanStart("chat");
  const sdk = deferred(),
    native = deferred();
  const started = beginChatWork("chat");
  const captured = vi.fn(() => sdk.promise);
  mock.invoke.mockImplementation(async (name: string) => {
    if (name === "ai_chat_register") return { ...status };
    if (name === "ai_chat_stop") {
      status = { ...status, revision: 2, blocked: true };
      mock.listeners.get("ai:chat-stop")?.({
        payload: { chatId: "chat", token: 1 },
      });
      await native.promise;
      status = { ...status, revision: 3, blocked: false };
    }
  });
  const stopped = stopChat("chat", options, captured);
  expect(captured).toHaveBeenCalledOnce(); // Captured before deletion removes the runtime.
  expect(stopChat("chat", options)).toBe(stopped);
  await expect(assertChatCanStart("chat")).rejects.toThrow("stopping");
  await vi.waitFor(() => expect(mock.listeners.has("ai:chat-stop")).toBe(true));
  sdk.resolve();
  await Promise.resolve();
  expect(mock.close).not.toHaveBeenCalled();
  started();
  await vi.waitFor(() =>
    expect(mock.invoke).toHaveBeenCalledWith("ai_chat_stop_ack", {
      chatId: "chat",
      token: 1,
      error: null,
    }),
  );
  expect(mock.close).toHaveBeenCalledWith("chat");
  await expect(assertChatCanStart("chat")).rejects.toThrow("stopping");
  native.resolve();
  await stopped;
  await assertChatCanStart("chat");
  expect(useChatStop.getState().states.chat.blocked).toBe(false);
});
it("retains a failed local Stop barrier until an explicit retry", async () => {
  const { stopChat, assertChatCanStart, useChatStop } = await import(
    "./chatStop"
  );
  mock.invoke.mockImplementation(async (name: string) => {
    if (name === "ai_chat_register") return { ...status };
    if (name === "ai_chat_stop") throw new Error("IPC unavailable");
  });
  await expect(stopChat("chat", options, mock.stop)).rejects.toThrow(
    "IPC unavailable",
  );
  expect(useChatStop.getState().states.chat.blocked).toBe(true);
  await expect(assertChatCanStart("chat")).rejects.toThrow("stopping");
  mock.invoke.mockImplementation(async (name: string) =>
    name === "ai_chat_register" ? { ...status } : undefined,
  );
  await stopChat("chat", options, mock.stop);
  await expect(assertChatCanStart("chat")).resolves.toBeUndefined();
});
it("blocks on another window's Stop and ignores stale unblock events", async () => {
  const { assertChatCanStart, useChatStop } = await import("./chatStop");
  await assertChatCanStart("chat");
  const event = mock.listeners.get("ai:chat-stop-state");
  if (!event) throw new Error("Missing stop state listener");
  event({ payload: { ...status, revision: 4, blocked: true } });
  event({ payload: { ...status, revision: 3, blocked: false } });
  expect(useChatStop.getState().states.chat.blocked).toBe(true);
  await expect(assertChatCanStart("chat")).rejects.toThrow("stopping");
  event({ payload: { ...status, revision: 5, blocked: false } });
  status.revision = 5;
  await assertChatCanStart("chat");
});
it("acknowledges shell cleanup failures instead of silently opening the gate", async () => {
  const { assertChatCanStart } = await import("./chatStop");
  await assertChatCanStart("chat");
  mock.close.mockRejectedValueOnce(new Error("close failed"));
  mock.listeners.get("ai:chat-stop")?.({
    payload: { chatId: "chat", token: 7 },
  });
  await vi.waitFor(() =>
    expect(mock.invoke).toHaveBeenCalledWith("ai_chat_stop_ack", {
      chatId: "chat",
      token: 7,
      error: "Error: close failed",
    }),
  );
});

it("rejects a stale register reply when another window begins stopping during the request", async () => {
  const { assertChatCanStart } = await import("./chatStop");
  await assertChatCanStart("chat");
  const reply = deferred();
  mock.invoke.mockImplementation(async () => {
    await reply.promise;
    return { ...status };
  });
  const pending = assertChatCanStart("chat");
  await Promise.resolve();
  mock.listeners.get("ai:chat-stop-state")?.({
    payload: { ...status, revision: 2, blocked: true },
  });
  reply.resolve();
  await expect(pending).rejects.toThrow("stopping");
});

it("waits for a paused approval's MCP lease before acknowledging remote Stop", async () => {
  const { assertChatCanStart } = await import("./chatStop");
  const { holdMcpRun, hasMcpRunLeases } = await import("../lib/mcpRunLeases");
  const cleanup = deferred();
  const release = vi.fn(() => cleanup.promise);
  holdMcpRun("chat", release);
  await assertChatCanStart("chat");
  mock.listeners.get("ai:chat-stop")?.({
    payload: { chatId: "chat", token: 42 },
  });
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(
    mock.invoke.mock.calls.some(([name]) => name === "ai_chat_stop_ack"),
  ).toBe(false);
  cleanup.resolve();
  await vi.waitFor(() =>
    expect(mock.invoke).toHaveBeenCalledWith("ai_chat_stop_ack", {
      chatId: "chat",
      token: 42,
      error: null,
    }),
  );
  expect(hasMcpRunLeases("chat")).toBe(false);
});

it("denies unanswered approvals when stopping an idle chat", async () => {
  const { assertChatCanStart } = await import("./chatStop");
  const { chats } = await import("./chatStore");
  const chat = chats.get("chat");
  if (!chat) throw new Error("missing chat fixture");
  chat.messages = [
    {
      id: "a",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "mcp_tool",
          toolCallId: "call",
          state: "approval-requested",
          input: {},
          approval: { id: "approval" },
        },
      ],
    },
  ];
  await assertChatCanStart("chat");
  mock.listeners.get("ai:chat-stop")?.({
    payload: { chatId: "chat", token: 43 },
  });
  await vi.waitFor(() => expect(mock.stop).toHaveBeenCalledOnce());
  expect(chat.messages[0].parts[0]).toMatchObject({
    state: "output-denied",
    approval: { approved: false },
  });
});

it("denies an approval delivered while the SDK is finishing Stop", async () => {
  const { assertChatCanStart } = await import("./chatStop");
  const { chats } = await import("./chatStore");
  const chat = chats.get("chat");
  if (!chat) throw new Error("missing chat fixture");
  chat.messages = [];
  const sdk = deferred();
  mock.stop.mockImplementationOnce(() => sdk.promise);
  await assertChatCanStart("chat");
  mock.listeners.get("ai:chat-stop")?.({
    payload: { chatId: "chat", token: 44 },
  });
  chat.messages = [
    {
      id: "late",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "mcp_tool",
          toolCallId: "call",
          state: "approval-requested",
          input: {},
          approval: { id: "approval" },
        },
      ],
    },
  ];
  sdk.resolve();
  await vi.waitFor(() =>
    expect(mock.invoke).toHaveBeenCalledWith("ai_chat_stop_ack", {
      chatId: "chat",
      token: 44,
      error: null,
    }),
  );
  expect(chat.messages[0].parts[0]).toMatchObject({
    state: "output-denied",
    approval: { approved: false },
  });
});

it("remote Stop cancels pending composer work before acknowledging cleanup", async () => {
  const { assertChatCanStart } = await import("./chatStop");
  const { beginComposerWork } = await import("../lib/composerWork");
  const work = beginComposerWork("chat");
  const unrelated = beginComposerWork("other");
  await assertChatCanStart("chat");
  mock.listeners.get("ai:chat-stop")?.({
    payload: { chatId: "chat", token: 45 },
  });
  expect(work.signal.aborted).toBe(true);
  expect(unrelated.signal.aborted).toBe(false);
  await vi.waitFor(() =>
    expect(mock.invoke).toHaveBeenCalledWith("ai_chat_stop_ack", {
      chatId: "chat",
      token: 45,
      error: null,
    }),
  );
  unrelated.finish();
});
