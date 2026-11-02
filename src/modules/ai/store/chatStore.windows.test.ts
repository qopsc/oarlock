import { usePreferencesStore } from "@/modules/settings/preferences";
import { expect, it, vi } from "vitest";
import {
  chats,
  seedMessages,
  useChatStore,
} from "@/modules/ai/store/chatStore";

vi.mock("@/modules/ai/lib/todos", () => ({
  deleteTodos: vi.fn(async () => {}),
}));

const background = vi.hoisted(() => ({
  shellBgKillChat: vi.fn(async (_id: string) => {}),
}));
vi.mock("../lib/native", () => ({ native: background }));
vi.mock("./chatStop", () => ({
  stopChat: async (
    id: string,
    options: { stopBackground: boolean },
    stop?: () => Promise<void> | void,
  ) => {
    await stop?.();
    if (options.stopBackground) await background.shellBgKillChat(id);
  },
}));

const chat = (id: string, title = "New chat") => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1,
});

const sessions = vi.hoisted(() => ({
  loadAll: vi.fn(),
  newSessionId: vi.fn(() => "s-new"),
  saveSessionsList: vi.fn(async () => {}),
  saveActiveId: vi.fn(async () => {}),
  onSessionsChanged: vi.fn(async () => () => {}),
  loadMessages: vi.fn(async () => null),
}));
vi.mock("@/modules/ai/lib/sessions", () => ({
  ...sessions,
  deleteSessionData: vi.fn(),
  deriveTitle: vi.fn(),
  saveMessages: vi.fn(),
}));

it("leaves another window's new chat to it and follows the shared list", async () => {
  sessions.loadAll.mockResolvedValue({
    sessions: [chat("s-1"), chat("s-2", "Old")],
    activeId: null,
    // The other window has the untitled chat open.
    activeElsewhere: new Set(["s-1"]),
  });
  await useChatStore.getState().hydrateSessions();
  expect(useChatStore.getState().activeSessionId).toBe("s-new");
  expect(sessions.onSessionsChanged).toHaveBeenCalledOnce();

  // Another window renamed a chat: the list follows, the open chat stays.
  const renamed = [chat("s-new"), chat("s-1", "Renamed"), chat("s-2", "Old")];
  useChatStore.getState().adoptSessionsList(renamed);
  expect(useChatStore.getState().sessions).toEqual(renamed);
  expect(useChatStore.getState().activeSessionId).toBe("s-new");

  // Another window deleted the chat open here: this window moves on.
  useChatStore.getState().adoptSessionsList([chat("s-2", "Old")]);
  await vi.waitFor(() =>
    expect(useChatStore.getState().activeSessionId).toBe("s-2"),
  );
});

it("cancels active and background conversations deleted in another window", async () => {
  const stop = vi.fn();
  type Runtime = NonNullable<ReturnType<typeof chats.get>>;
  chats.set("deleted", { stop, status: "streaming" } as unknown as Runtime);
  chats.set("background", { stop, status: "streaming" } as unknown as Runtime);
  chats.set("remaining", { stop: vi.fn() } as unknown as Runtime);
  seedMessages.set("background", []);
  useChatStore.setState({
    sessions: [chat("deleted"), chat("background"), chat("remaining")],
    activeSessionId: "deleted",
  });
  useChatStore.getState().adoptSessionsList([chat("remaining")]);
  expect(stop).toHaveBeenCalledTimes(2);
  expect(useChatStore.getState().activeSessionId).toBe("remaining");
  expect(chats.has("deleted")).toBe(false);
  expect(chats.has("background")).toBe(false);
  expect(seedMessages.has("background")).toBe(false);
});

it("does not reactivate a remotely deleted conversation after its load resolves", async () => {
  let finish!: (messages: null) => void;
  sessions.loadMessages.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useChatStore.setState({
    sessions: [chat("current"), chat("loading")],
    activeSessionId: "current",
  });
  useChatStore.getState().switchSession("loading");
  useChatStore.getState().adoptSessionsList([chat("current")]);
  finish(null);
  await Promise.resolve();
  expect(useChatStore.getState().activeSessionId).toBe("current");
});

it("keeps the latest selection when conversation loads finish out of order", async () => {
  let finish!: (messages: null) => void;
  sessions.loadMessages.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useChatStore.setState({
    sessions: [chat("current"), chat("slow")],
    activeSessionId: "current",
  });
  useChatStore.getState().switchSession("slow");
  useChatStore.getState().newSession();
  finish(null);
  await Promise.resolve();
  expect(useChatStore.getState().activeSessionId).toBe("s-new");
});

it("loads a replacement conversation before activating it after local deletion", async () => {
  let finish!: (messages: null) => void;
  sessions.loadMessages.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useChatStore.setState({
    sessions: [chat("to-delete"), chat("unopened")],
    activeSessionId: "to-delete",
  });
  useChatStore.getState().deleteSession("to-delete");
  expect(useChatStore.getState().activeSessionId).toBeNull();
  expect(sessions.loadMessages).toHaveBeenLastCalledWith("unopened");
  finish(null);
  await Promise.resolve();
  expect(useChatStore.getState().activeSessionId).toBe("unopened");
});

it("clears a remotely deleted active selection while its replacement loads", async () => {
  let finish!: (messages: null) => void;
  sessions.loadMessages.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useChatStore.setState({
    sessions: [chat("remote-delete"), chat("replacement")],
    activeSessionId: "remote-delete",
  });
  useChatStore.getState().adoptSessionsList([chat("replacement")]);
  expect(useChatStore.getState().activeSessionId).toBeNull();
  finish(null);
  await Promise.resolve();
  expect(useChatStore.getState().activeSessionId).toBe("replacement");
});

it("moves on when a second window deletes the replacement while it is loading", async () => {
  let finish!: (messages: null) => void;
  sessions.loadMessages.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useChatStore.setState({
    sessions: [chat("first-delete"), chat("second-delete"), chat("survivor")],
    activeSessionId: "first-delete",
  });
  useChatStore
    .getState()
    .adoptSessionsList([chat("second-delete"), chat("survivor")]);
  useChatStore.getState().adoptSessionsList([chat("survivor")]);
  await Promise.resolve();
  finish(null);
  await Promise.resolve();
  expect(useChatStore.getState().activeSessionId).toBe("survivor");
});

it("only stops a chat's background jobs when enabled, including deletion of an idle chat", async () => {
  usePreferencesStore.setState({ aiStopBackgroundJobs: false });
  useChatStore.getState().stopSession("background-owner");
  expect(background.shellBgKillChat).not.toHaveBeenCalled();
  usePreferencesStore.setState({ aiStopBackgroundJobs: true });
  useChatStore.getState().stopSession("background-owner");
  await vi.waitFor(() =>
    expect(background.shellBgKillChat).toHaveBeenCalledWith("background-owner"),
  );
  useChatStore.setState({
    sessions: [chat("idle-owner"), chat("keep")],
    activeSessionId: "keep",
  });
  useChatStore.getState().adoptSessionsList([chat("keep")]);
  await vi.waitFor(() =>
    expect(background.shellBgKillChat).toHaveBeenCalledWith("idle-owner"),
  );
  usePreferencesStore.setState({ aiStopBackgroundJobs: false });
});
