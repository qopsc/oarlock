import { beforeEach, describe, expect, it, vi } from "vitest";

const aiSdkReact = vi.hoisted(() => {
  const constructed: {
    id: string;
    messages?: unknown[];
    transport: unknown;
  }[] = [];
  const sent: unknown[] = [];
  class Chat {
    id: string;
    transport: unknown;
    messages: unknown[];
    constructor(opts: {
      id: string;
      messages?: unknown[];
      transport: unknown;
    }) {
      this.id = opts.id;
      this.transport = opts.transport;
      this.messages = opts.messages ?? [];
      constructed.push(opts);
    }
    async sendMessage(msg: unknown) {
      sent.push(msg);
    }
  }
  return { Chat, constructed, sent };
});

vi.mock("@ai-sdk/react", () => ({ Chat: aiSdkReact.Chat }));

vi.mock("ai", () => ({
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(),
}));

const configMock = vi.hoisted(() => ({
  getModel: vi.fn(() => ({ provider: "openai" })),
  providerNeedsKey: vi.fn(() => true),
}));

vi.mock("../config", () => configMock);

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({ hydrated: true, error: null, syncing: false }),
  },
}));

vi.mock("../lib/agents", () => ({
  BUILTIN_AGENTS: [{ id: "builtin-coder", name: "Coder", instructions: "" }],
}));

vi.mock("./agentsStore", () => ({
  useAgentsStore: {
    getState: () => ({ customAgents: [], activeId: "builtin-coder" }),
  },
}));

vi.mock("./planStore", () => ({
  usePlanStore: { getState: () => ({ active: false }) },
}));

vi.mock("../lib/transport", () => ({
  createContextAwareTransport: vi.fn(() => "transport"),
}));

const chatStore = vi.hoisted(() => {
  const state = {
    chatsMap: new Map<string, unknown>(),
    seeds: new Map<string, unknown[]>(),
    touched: [] as string[],
    sessionActive: "session-1" as string | null,
    modelId: "gpt-test",
  };
  const useChatStore = {
    getState: () => ({
      activeSessionId: state.sessionActive,
      selectedModelId: state.modelId,
      live: {},
    }),
  };
  return {
    state,
    useChatStore,
    chats: state.chatsMap,
    seedMessages: state.seeds,
    touchChat: vi.fn((id: string, chat: unknown) => {
      state.chatsMap.set(id, chat);
      state.touched.push(id);
    }),
  };
});

vi.mock("./chatStore", () => ({
  chats: chatStore.chats,
  seedMessages: chatStore.seedMessages,
  get touchChat() {
    return chatStore.touchChat;
  },
  useChatStore: chatStore.useChatStore,
}));

import { getOrCreateChat, sendMessage } from "./chatRuntime";

describe("chat runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiSdkReact.sent.length = 0;
    aiSdkReact.constructed.length = 0;
    chatStore.state.chatsMap.clear();
    chatStore.state.seeds.clear();
    chatStore.state.touched.length = 0;
    chatStore.state.sessionActive = "session-1";
    configMock.providerNeedsKey.mockReturnValue(true);
  });

  it("refuses to send without an active session", async () => {
    chatStore.state.sessionActive = null;

    await expect(sendMessage("hi")).resolves.toBe(false);
    expect(aiSdkReact.constructed).toEqual([]);
  });

  it("sends through a chat bound to the active session", async () => {
    await expect(sendMessage("do the thing")).resolves.toBe(true);

    expect(aiSdkReact.constructed[0].id).toBe("session-1");
    expect(aiSdkReact.sent).toEqual([{ text: "do the thing" }]);
  });

  it("reuses an existing chat instead of constructing another", () => {
    const first = getOrCreateChat("session-1");
    const second = getOrCreateChat("session-1");

    expect(second).toBe(first);
    expect(aiSdkReact.constructed).toHaveLength(1);
    expect(chatStore.state.touched).toEqual(["session-1", "session-1"]);
  });

  it("consumes seeded messages exactly once when constructing", () => {
    const seeded = [{ id: "m1", role: "user", parts: [] }];
    chatStore.state.seeds.set("session-1", seeded);

    const chat = getOrCreateChat("session-1");

    expect(chat.id).toBe("session-1");
    expect(aiSdkReact.constructed[0].messages).toBe(seeded);
    expect(chatStore.state.seeds.has("session-1")).toBe(false);
  });

  it("expires restored approvals but preserves approvals of a live runtime", () => {
    const parts = [
      "approval-requested",
      "approval-responded",
      "output-available",
    ].map((state, i) => ({
      type: "dynamic-tool",
      toolName: "shell",
      toolCallId: `call-${i}`,
      state,
      input: { command: "touch result.txt" },
      approval: { id: `approval-${i}`, approved: true },
    }));
    chatStore.state.seeds.set("session-1", [
      { id: "a", role: "assistant", parts },
    ]);
    const restored = getOrCreateChat("session-1");
    expect(restored.messages[0].parts.slice(0, 2)).toEqual(
      parts.slice(0, 2).map((part) => ({
        ...part,
        state: "output-denied",
        approval: {
          ...part.approval,
          approved: false,
          reason: expect.stringContaining("approval expired"),
        },
      })),
    );
    expect(restored.messages[0].parts[2]).toBe(parts[2]);
    restored.messages = [
      { id: "live", role: "assistant", parts: [parts[0]] },
    ] as never;
    expect(getOrCreateChat("session-1").messages[0].parts[0]).toBe(parts[0]);
  });
});

vi.mock("./chatStop", () => ({
  assertChatCanStart: vi.fn(async () => {}),
  assertChatNotStopping: vi.fn(),
  stopChat: vi.fn(async (_id, _options, stop) => {
    await stop?.();
  }),
}));
