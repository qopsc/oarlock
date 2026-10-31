import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { toast } from "sonner";
import type { WorkspaceEnv } from "@/modules/workspace/env";
import { DiscardCoordinator, type DiscardEvent } from "./discardCoordinator";
import { prepareNativeDiscard } from "./gitSignals";

let current: DiscardCoordinator | undefined;

export function installDiscardCoordinator(): () => void {
  let alive = true;
  let unlisten: (() => void) | undefined;
  let client: DiscardCoordinator | undefined;
  let starting = false;
  const start = async () => {
    // Registration replaces the native page token. Do not issue overlapping
    // attempts: their IPC replies can arrive in a different order.
    if (!alive || starting) return;
    starting = true;
    unlisten?.();
    client?.dispose();
    const next = new DiscardCoordinator({
      invoke,
      prepare: (scope, preserve) =>
        prepareNativeDiscard(scope.workspace, preserve, (id, token, paths) =>
          invoke<boolean[]>("git_discard_match_documents", {
            id,
            token,
            paths,
          }),
        ),
      problem: (error) => {
        if (alive)
          toast.error("Editor synchronization interrupted", {
            id: "discard-sync",
            description: String(error),
          });
      },
    });
    client = next;
    try {
      const off = await getCurrentWebviewWindow().listen<DiscardEvent>(
        "git:discard",
        ({ payload }) => next.receive(payload),
      );
      if (!alive) {
        off();
        next.dispose();
        return;
      }
      unlisten = off;
      const registration = await invoke<{
        token: string;
        events: DiscardEvent[];
      }>("git_discard_register");
      next.ready(registration.token);
      for (const event of registration.events) next.receive(event);
      if (alive) {
        current = next;
        toast.dismiss("discard-sync");
      }
    } catch (error) {
      next.dispose();
      unlisten?.();
      unlisten = undefined;
      if (alive)
        toast.error("Could not synchronize editor windows", {
          id: "discard-sync",
          description: String(error),
          duration: Number.POSITIVE_INFINITY,
          action: {
            label: "Retry",
            onClick: () => {
              void start();
            },
          },
        });
    } finally {
      starting = false;
    }
  };
  void start();
  return () => {
    alive = false;
    if (current === client) current = undefined;
    client?.dispose();
    unlisten?.();
  };
}

export function discardAcrossWindows(
  repoRoot: string,
  entries: { path: string; untracked: boolean }[],
  workspace: WorkspaceEnv,
): Promise<void> {
  if (!current)
    return Promise.reject(
      new Error(
        "Editor synchronization is not ready. Retry after all windows have loaded.",
      ),
    );
  return current.execute({ repoRoot, entries, workspace });
}
