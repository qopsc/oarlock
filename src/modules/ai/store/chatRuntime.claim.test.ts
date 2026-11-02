import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  run: vi.fn(async () => ({ stream: {}, tools: {} })),
  admissions: [] as string[],
  invoke: vi.fn(async (_command: string, _args?: unknown) => undefined),
}));
vi.mock("../lib/agent", () => ({ runAgentStream: mock.run }));
vi.mock("../lib/native", () => ({ native: {}, createNative: () => ({}) }));
vi.mock("@/modules/mcp", () => ({ mcpToolsForRun: async () => null }));
vi.mock("@/modules/skills/catalog", () => ({
  loadAgentSkills: async () => undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("./chatStop", () => ({
  assertChatNotStopping: () => {},
  assertChatCanStart: async () => {},
  beginRunAdmission: async (_chat: string, runId: string) => {
    mock.admissions.push(runId);
  },
  stopChat: vi.fn(),
}));
vi.mock("ai", async (original) => ({
  ...(await original<object>()),
  toUIMessageStream: () => new ReadableStream({ start() {} }),
}));
import { usePreferencesStore } from "@/modules/settings/preferences";
import { DEFAULT_PREFERENCES } from "@/modules/settings/store";
import { beginRun, closeChatRuns } from "../lib/runOwner";
import { chats } from "./chatStore";
import { getOrCreateChat, sendUserMessage } from "./chatRuntime";

const parts = [{ type: "text" as const, text: "hello" }];
const ended = () =>
  mock.invoke.mock.calls.filter(([command]) => command === "ai_run_end");

beforeEach(() => {
  mock.run.mockClear();
  mock.invoke.mockClear();
  mock.admissions.length = 0;
  chats.clear();
  usePreferencesStore.setState({
    ...DEFAULT_PREFERENCES,
    hydrated: true,
    syncing: false,
    error: null,
  });
});

it("a real Chat's transport claims the composer's owner: one native run per turn", async () => {
  const chat = getOrCreateChat("claim-chat");
  const owner = beginRun("claim-chat", {
    kind: "prepare",
    admit: async (runId) => {
      mock.admissions.push(runId);
    },
  });
  const pending = sendUserMessage(chat, { role: "user", parts }, (id) =>
    owner.accept(id),
  );
  await vi.waitFor(() => expect(mock.run).toHaveBeenCalledOnce());
  expect(mock.admissions).toEqual([owner.runId]);
  expect(owner.phase).toBe("running");
  void pending.catch(() => {});
  await closeChatRuns("claim-chat", "stop");
  expect(ended()).toHaveLength(1);
});

it("regenerating a message after Stop is not refused", async () => {
  const chat = getOrCreateChat("regen-chat");
  const owner = beginRun("regen-chat", {
    kind: "prepare",
    admit: async (runId) => {
      mock.admissions.push(runId);
    },
  });
  const pending = sendUserMessage(chat, { role: "user", parts }, (id) =>
    owner.accept(id),
  );
  void pending.catch(() => {});
  await vi.waitFor(() => expect(mock.run).toHaveBeenCalledOnce());
  await closeChatRuns("regen-chat", "stop");
  const user = chat.messages.find((m) => m.role === "user");
  expect(user).toBeDefined();
  const again = chat.regenerate({ messageId: user?.id });
  void again.catch(() => {});
  await vi.waitFor(() => expect(mock.run).toHaveBeenCalledTimes(2));
  expect(mock.admissions).toHaveLength(2);
  await closeChatRuns("regen-chat", "stop");
});
