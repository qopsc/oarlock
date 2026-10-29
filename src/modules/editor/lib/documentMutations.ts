import {
  recoveryMutationCoverage,
  recoveryTargetsChanged,
} from "./recoveryTarget";
import { beginDocumentMutation } from "./quitBarrier";
import type { Tab } from "@/modules/tabs";
import {
  LOCAL_WORKSPACE,
  workspaceEnvForPath,
  workspaceScopeKey,
  type WorkspaceEnv,
} from "@/modules/workspace/env";
import { renamedPath, pathAtOrUnder } from "@/app/hooks/tabCloseGuards";

export type DocumentMutation = { sequence: number; workspace: WorkspaceEnv } & (
  | { kind: "renamed"; from: string; to: string }
  | { kind: "deleted"; paths: string[] }
);
type Space = { id: string; env?: WorkspaceEnv };

/** Missing spaces have no known owner; never reinterpret them as host files. */
export function documentTabsInEnvironment(
  tabs: readonly Tab[],
  spaces: readonly Space[],
  workspace: WorkspaceEnv,
): Tab[] {
  const owners = new Map(
    spaces.map((space) => [space.id, space.env ?? LOCAL_WORKSPACE]),
  );
  const scope = workspaceScopeKey(workspace);
  return tabs.filter((tab) => {
    if (tab.kind !== "editor" && tab.kind !== "markdown") return false;
    const owner = owners.get(tab.spaceId);
    return (
      owner !== undefined &&
      workspaceScopeKey(workspaceEnvForPath(tab.path, owner)) === scope
    );
  });
}

export function planDocumentMutation(
  tabs: readonly Tab[],
  spaces: readonly Space[],
  event: DocumentMutation,
) {
  const owned = documentTabsInEnvironment(tabs, spaces, event.workspace);
  const renamed: {
    id: number;
    from: string;
    path: string;
    title: string;
    preserveBuffer: boolean;
  }[] = [];
  const deleted: number[] = [];
  const refresh: number[] = [];
  for (const tab of owned) {
    if (tab.kind !== "editor" && tab.kind !== "markdown") continue;
    if (tab.kind === "editor" && tab.detached) continue;
    if (event.kind === "deleted") {
      if (event.paths.some((path) => pathAtOrUnder(tab.path, path)))
        deleted.push(tab.id);
      continue;
    }
    const path = renamedPath(tab.path, event.from, event.to);
    if (path !== null && path !== tab.path) {
      renamed.push({
        id: tab.id,
        from: tab.path,
        path,
        title: path.slice(path.lastIndexOf("/") + 1),
        preserveBuffer: tab.kind === "editor" && !tab.cold,
      });
    } else if (pathAtOrUnder(tab.path, event.to)) {
      // A move may replace the destination in another window. Dirty editors
      // retain their draft; their next conditional save detects the conflict.
      refresh.push(tab.id);
    }
  }
  return { renamed, deleted, refresh };
}

/** One listener lifetime; async setup cannot leak after disposal or Retry. */
export function subscribeDocumentMutations(
  listen: (receive: (event: DocumentMutation) => void) => Promise<() => void>,
  apply: (event: DocumentMutation) => void,
  failed: (error: unknown) => void,
  ready: () => void = () => {},
): () => void {
  let live = true;
  let last = 0;
  let unlisten: (() => void) | undefined;
  let pending: DocumentMutation[] | null = null;
  let releasePending: (() => void) | undefined;
  recoveryMutationCoverage(false);
  void listen((event) => {
    if (!live || event.sequence <= last) return;
    last = event.sequence;
    recoveryTargetsChanged(
      workspaceScopeKey(event.workspace),
      event.kind === "deleted" ? event.paths : [event.from, event.to],
    );
    if (pending) {
      pending.push(event);
      return;
    }
    const batch = [event];
    pending = batch;
    const mutation = beginDocumentMutation();
    releasePending = mutation.release;
    const drain = () => {
      try {
        // flushSync in the caller commits each binding before the next event
        // computes its plan. Never coalesce successive renames or deletions.
        for (const queued of batch) {
          if (!live) break;
          apply(queued);
        }
      } catch (error) {
        if (live) {
          recoveryMutationCoverage(false);
          failed(error);
        }
      } finally {
        pending = null;
        releasePending = undefined;
        mutation.release();
      }
    };
    if (mutation.ready) void mutation.ready.then(drain);
    else drain();
  }).then(
    (stop) => {
      if (live) {
        unlisten = stop;
        recoveryMutationCoverage(true);
        ready();
      } else stop();
    },
    (error) => {
      if (live) {
        recoveryMutationCoverage(false);
        failed(error);
      }
    },
  );
  return () => {
    if (!live) return;
    live = false;
    recoveryMutationCoverage(false);
    if (pending) pending.length = 0;
    releasePending?.();
    unlisten?.();
  };
}
