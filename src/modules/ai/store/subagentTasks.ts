import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

export type SubagentTask = {
  id: string;
  sessionId: string;
  title: string;
  kind: string;
  modelId: string;
  prompt: string;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  step: string | null;
  result: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  inputTokens: number;
  outputTokens: number;
};
type Snapshot = { revision: number; tasks: SubagentTask[] };
type Change = { revision: number; task: SubagentTask; removed: string[] };
export const useSubagentTasks = create<Snapshot>(() => ({
  revision: 0,
  tasks: [],
}));
export const taskCommand = <T>(request: Record<string, unknown>) =>
  invoke<T>("ai_subagent_task", { request });

export function applyTaskChange(snapshot: Snapshot, change: Change): Snapshot {
  if (change.revision <= snapshot.revision) return snapshot;
  return {
    revision: change.revision,
    tasks: [
      change.task,
      ...snapshot.tasks.filter((t) => t.id !== change.task.id),
    ]
      .filter((t) => !change.removed.includes(t.id))
      .sort((a, b) => b.startedAt - a.startedAt),
  };
}
let initialization: Promise<void> | undefined;
export function initializeTasks(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    let pending: Change[] | null = [];
    const unlisten = await listen<Change>("ai:subagent-task", ({ payload }) => {
      if (pending) pending.push(payload);
      else useSubagentTasks.setState((s) => applyTaskChange(s, payload));
    });
    try {
      let snapshot = await taskCommand<Snapshot>({ action: "list" });
      for (const change of pending.sort((a, b) => a.revision - b.revision))
        snapshot = applyTaskChange(snapshot, change);
      pending = null;
      useSubagentTasks.setState(snapshot);
    } catch (error) {
      unlisten();
      throw error;
    }
  })().catch((error) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}
const controllers = new Map<string, AbortController>();
let owner: Promise<number> | undefined;
export function taskOwner(): Promise<number> {
  if (owner) return owner;
  owner = (async () => {
    const unlisten = await listen<string>("ai:subagent-cancel", ({ payload }) =>
      controllers.get(payload)?.abort(),
    );
    try {
      return await taskCommand<number>({ action: "open" });
    } catch (error) {
      unlisten();
      throw error;
    }
  })().catch((error) => {
    owner = undefined;
    throw error;
  });
  return owner;
}
export function registerTask(
  id: string,
  controller: AbortController,
): () => void {
  controllers.set(id, controller);
  return () => {
    controllers.delete(id);
  };
}
export async function cancelTask(id: string): Promise<void> {
  controllers.get(id)?.abort();
  await taskCommand({ action: "cancel", id });
}
export async function cancelChatTasks(sessionId: string): Promise<void> {
  // Also covers runs started in another window, and runs whose parent has stopped.
  for (const task of useSubagentTasks.getState().tasks) {
    if (task.sessionId === sessionId) controllers.get(task.id)?.abort();
  }
  await taskCommand({ action: "cancelChat", sessionId });
}
