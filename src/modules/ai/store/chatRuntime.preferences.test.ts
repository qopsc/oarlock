import { beforeEach, expect, it, vi } from "vitest";
const run = vi.hoisted(() => vi.fn(async () => ({ stream: {}, tools: {} })));
vi.mock("../lib/agent", () => ({ runAgentStream: run }));
vi.mock("../lib/native", () => ({ native: {}, createNative: () => ({}) }));
vi.mock("@/modules/mcp", () => ({ mcpToolsForRun: async () => null }));
vi.mock("@/modules/skills/catalog", () => ({
  loadAgentSkills: async () => undefined,
}));
vi.mock("./chatStop", () => ({
  assertChatNotStopping: () => {},
  assertChatCanStart: async () => {},
  stopChat: vi.fn(),
}));
vi.mock("ai", async (original) => ({
  ...(await original<object>()),
  toUIMessageStream: () =>
    new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
}));
import { usePreferencesStore } from "@/modules/settings/preferences";
import { DEFAULT_PREFERENCES } from "@/modules/settings/store";
import { EMPTY_PROVIDER_KEYS } from "../lib/keyring";
import { chats, useChatStore } from "./chatStore";
import { getOrCreateChat, sendUserMessage } from "./chatRuntime";
it("does not enter the model runner when saved preferences failed to load", async () => {
  usePreferencesStore.setState({
    ...DEFAULT_PREFERENCES,
    hydrated: false,
    error: "Preferences file could not be loaded",
  });
  useChatStore.setState({
    apiKeys: { ...EMPTY_PROVIDER_KEYS, openai: "synthetic-key" },
  });
  chats.clear();
  const accepted = vi.fn();
  const chat = getOrCreateChat("unresolved-preferences");
  await expect(
    sendUserMessage(chat, { text: "synthetic editor context" }, accepted),
  ).rejects.toThrow("Preferences");
  expect(accepted).not.toHaveBeenCalled();
  expect(chat.messages).toHaveLength(0);
  expect(run).not.toHaveBeenCalled();
});

beforeEach(() => {
  run.mockClear();
  chats.clear();
  usePreferencesStore.setState({
    ...DEFAULT_PREFERENCES,
    hydrated: true,
    syncing: false,
    error: null,
  });
});
it.each([{ syncing: true }, { error: "read failed" }, { hydrated: false }])(
  "blocks new messages while preferences are unresolved: %j, then permits an explicit retry",
  async (patch) => {
    usePreferencesStore.setState(patch);
    const chat = getOrCreateChat("retry");
    const accepted = vi.fn();
    await expect(
      sendUserMessage(chat, { text: "draft" }, accepted),
    ).rejects.toThrow("Preferences");
    expect(run).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
    expect(chat.messages).toHaveLength(0);
    usePreferencesStore.setState({
      hydrated: true,
      syncing: false,
      error: null,
    });
    expect(run).not.toHaveBeenCalled();
    await sendUserMessage(chat, { text: "draft" }, accepted);
    expect(run).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledOnce();
  },
);
