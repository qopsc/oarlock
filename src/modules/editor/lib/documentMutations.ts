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

/** One listener lifetime. Reconciliation precedes events after a gap or failure. */
export function subscribeDocumentMutations(
  listen: (receive: (event: DocumentMutation) => void) => Promise<() => void>,
  apply: (event: DocumentMutation) => void,
  failed: (error: unknown, retry?: () => void) => void,
  ready: () => void = () => {},
  reconcile?: (workspace: WorkspaceEnv | undefined, isLive: () => boolean) => Promise<void>,
): () => void {
  type Work = { event: DocumentMutation } | { reconcile: WorkspaceEnv | undefined };
  let live = true;
  let last = 0;
  let unlisten: (() => void) | undefined;
  let busy = false;
  let stalled = false;
  let releasePending: (() => void) | undefined;
  const pending: Work[] = [];
  recoveryMutationCoverage(false);

  const drain = () => {
    if (!live || busy || stalled || pending.length === 0) return;
    busy = true;
    const mutation = beginDocumentMutation();
    releasePending = mutation.release;
    const finish = () => {
      busy = false;
      releasePending = undefined;
      mutation.release();
      if (live && unlisten && !stalled && pending.length === 0) {
        recoveryMutationCoverage(true);
        ready();
      }
      drain();
    };
    const retry = () => {
      if (!live) return;
      stalled = false;
      drain();
    };
    const run = () => {
      while (live && pending.length > 0) {
        const work = pending[0];
        if ("reconcile" in work) {
          if (!reconcile) {
            pending.shift();
            continue;
          }
          recoveryMutationCoverage(false);
          void Promise.resolve().then(() => reconcile(work.reconcile, () => live)).then(
            () => {
              const index = pending.indexOf(work);
              if (live && index >= 0) pending.splice(index, 1);
              finish();
            },
            (error) => {
              if (live) {
                stalled = true;
                recoveryMutationCoverage(false);
                failed(error, retry);
              }
              finish();
            },
          );
          return;
        }
        pending.shift();
        try {
          apply(work.event);
        } catch (error) {
          recoveryMutationCoverage(false);
          if (reconcile) pending.unshift({ reconcile: work.event.workspace });
          else failed(error);
        }
      }
      finish();
    };
    if (mutation.ready) void mutation.ready.then(run);
    else run();
  };

  void listen((event) => {
    if (!live || event.sequence <= last) return;
    if (last !== 0 && event.sequence !== last + 1 && reconcile) {
      recoveryMutationCoverage(false);
      pending.push({ reconcile: undefined });
    }
    last = event.sequence;
    recoveryTargetsChanged(
      workspaceScopeKey(event.workspace),
      event.kind === "deleted" ? event.paths : [event.from, event.to],
    );
    pending.push({ event });
    drain();
  }).then(
    (stop) => {
      if (!live) {
        stop();
        return;
      }
      unlisten = stop;
      if (reconcile) {
        pending.unshift({ reconcile: undefined });
        drain();
      } else {
        recoveryMutationCoverage(true);
        ready();
      }
    },
    (error) => {
      if (live) {
        recoveryMutationCoverage(false);
        if (reconcile)
          void Promise.resolve().then(() => reconcile(undefined, () => live)).catch((reconcileError) => console.error(reconcileError));
        failed(error);
      }
    },
  );
  return () => {
    if (!live) return;
    live = false;
    recoveryMutationCoverage(false);
    pending.length = 0;
    releasePending?.();
    unlisten?.();
  };
}
