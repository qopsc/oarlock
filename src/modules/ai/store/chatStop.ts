import { cancelComposerWork } from "../lib/composerWork";
import { denyUnansweredApprovals } from "../lib/toolApprovals";
import { releaseChatMcpRuns } from "../lib/mcpRunLeases";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { toast } from "sonner";
import { drainChatWork } from "../lib/chatWork";
import { chats } from "./chatStore";

type Status = {
  chatId: string;
  revision: number;
  blocked: boolean;
  error: string | null;
};
export const useChatStop = create<{ states: Record<string, Status> }>(() => ({
  states: {},
}));
const stopping = new Map<string, Promise<void>>();
const localStops = new Map<string, Promise<void>>();
function stopLocal(
  chatId: string,
  stop?: () => Promise<void> | void,
): Promise<void> {
  cancelComposerWork(chatId);
  const existing = localStops.get(chatId);
  if (existing) return existing;
  const chat = chats.get(chatId);
  let stopped: Promise<void>;
  try {
    stopped = stop
      ? Promise.resolve(stop())
      : Promise.resolve(chats.get(chatId)?.stop());
  } catch (error) {
    stopped = Promise.reject(error);
  }
  const work = (async () => {
    await stopped;
    // The SDK can flush final tool parts while stopping. Deny after that drain.
    if (chat?.messages)
      chat.messages = denyUnansweredApprovals(
        chat.messages,
        "Approval closed: the user stopped this chat.",
      );
    await drainChatWork(chatId);
    await releaseChatMcpRuns(chatId);
    const { settleShellClosures } = await import("../tools/shell");
    await settleShellClosures(chatId);
  })();
  localStops.set(chatId, work);
  void work.catch(() => {});
  return work;
}
let initialized: Promise<void> | undefined;
function adopt(status: Status) {
  useChatStop.setState((s) => {
    if ((s.states[status.chatId]?.revision ?? -1) > status.revision) return s;
    return { states: { ...s.states, [status.chatId]: status } };
  });
}
function initialize(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    const off = await listen<Status>("ai:chat-stop-state", ({ payload }) =>
      adopt(payload),
    );
    try {
      await listen<{ chatId: string; token: number }>(
        "ai:chat-stop",
        ({ payload }) => {
          void (async () => {
            let error: string | null = null;
            try {
              await stopLocal(payload.chatId);
            } catch (e) {
              error = String(e);
            }
            localStops.delete(payload.chatId);
            await invoke("ai_chat_stop_ack", { ...payload, error });
          })().catch((e) =>
            toast.error("Could not acknowledge Stop", {
              description: String(e),
            }),
          );
        },
      );
    } catch (e) {
      off();
      throw e;
    }
  })().catch((e) => {
    initialized = undefined;
    throw e;
  });
  return initialized;
}
export function assertChatNotStopping(chatId: string): void {
  if (stopping.has(chatId) || useChatStop.getState().states[chatId]?.blocked)
    throw new Error(
      "This chat is still stopping. Wait for cleanup or retry Stop.",
    );
}
export async function assertChatCanStart(chatId: string): Promise<void> {
  assertChatNotStopping(chatId);
  await initialize();
  const status = await invoke<Status>("ai_chat_register", { chatId });
  adopt(status);
  if (
    status.blocked ||
    useChatStop.getState().states[chatId]?.blocked ||
    stopping.has(chatId)
  )
    throw new Error(
      status.error ??
        "This chat is still stopping. Wait for cleanup before sending another turn.",
    );
}
export function stopChat(
  chatId: string,
  options: { stopBackground: boolean; stopSubagents: boolean },
  localStop?: () => Promise<void> | void,
): Promise<void> {
  const existing = stopping.get(chatId);
  if (existing) return existing;
  void stopLocal(chatId, localStop);
  const current = useChatStop.getState().states[chatId];
  adopt({
    chatId,
    revision: current?.revision ?? 0,
    blocked: true,
    error: null,
  });
  const promise = (async () => {
    await initialize();
    // Registration guarantees this window receives the cleanup request too.
    await invoke<Status>("ai_chat_register", { chatId });
    await invoke("ai_chat_stop", { chatId, ...options });
    const done = await invoke<Status>("ai_chat_register", { chatId });
    adopt(done);
    if (done.blocked)
      throw new Error(done.error ?? "This chat is still stopping.");
  })()
    .catch((error) => {
      localStops.delete(chatId);
      const latest = useChatStop.getState().states[chatId];
      adopt({
        chatId,
        revision: latest?.revision ?? 0,
        blocked: true,
        error: String(error),
      });
      toast.error("Could not finish stopping chat", {
        description: String(error),
        action: {
          label: "Retry Stop",
          onClick: () => {
            void stopChat(chatId, options).catch(() => {});
          },
        },
      });
      throw error;
    })
    .finally(() => {
      if (stopping.get(chatId) === promise) stopping.delete(chatId);
    });
  stopping.set(chatId, promise);
  return promise;
}
