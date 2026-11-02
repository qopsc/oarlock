import {
  recoveryMutationCoverage,
  recoveryTargetsChanged,
} from "./recoveryTarget";
import { beginDocumentMutation } from "./quitBarrier";
import {
  mutationFenceAdvance,
  mutationFenceDown,
  mutationFenceLive,
} from "./mutationFence";
import type { Tab } from "@/modules/tabs";
import {
  LOCAL_WORKSPACE,
  workspaceEnvForPath,
  workspaceScopeKey,
  type WorkspaceEnv,
} from "@/modules/workspace/env";
import { renamedPath, pathAtOrUnder } from "@/app/hooks/tabCloseGuards";

export type DiscardBegin = {
  sequence: number;
  workspace: WorkspaceEnv;
  kind: "discard-begin";
  id: number;
  origin: string;
  repoRoot: string;
  /** Canonical entry names native resolved; a spelling through a link is not one. */
  roots: string[];
};
export type DiscardEnd = {
  sequence: number;
  workspace: WorkspaceEnv;
  kind: "discard-end";
  id: number;
  ok: boolean;
};
export type PathMutation = { sequence: number; workspace: WorkspaceEnv } & (
  | { kind: "renamed"; from: string; to: string }
  | { kind: "deleted"; paths: string[] }
);
export type DocumentMutation = PathMutation | DiscardBegin | DiscardEnd;
/** Source Control Discard announcements; native sends them on the same stream. */
export type DiscardChannel = {
  begin: (event: DiscardBegin) => void;
  end: (event: DiscardEnd) => void;
  reset: () => void;
  /** The stream's current sequence, for a listener that has just gone live. */
  currentSequence: () => Promise<number>;
};
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
  if (event.kind === "discard-begin" || event.kind === "discard-end")
    return { renamed, deleted, refresh };
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
  apply: (event: PathMutation) => void,
  failed: (error: unknown, retry?: () => void) => void,
  ready: () => void = () => {},
  reconcile?: (workspace: WorkspaceEnv | undefined, isLive: () => boolean, failedEvent?: PathMutation) => Promise<void>,
  discard?: DiscardChannel,
): () => void {
  type Work = { event: PathMutation } | { reconcile: WorkspaceEnv | undefined; failedEvent?: PathMutation };
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
          void Promise.resolve().then(() => reconcile(work.reconcile, () => live, work.failedEvent)).then(
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
          if (reconcile) pending.unshift({ reconcile: work.event.workspace, failedEvent: work.event });
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
    // A missed event may have been a discard-end or the begin of a rewrite.
    if (last !== 0 && event.sequence !== last + 1) discard?.reset();
    if (last !== 0 && event.sequence !== last + 1 && reconcile) {
      recoveryMutationCoverage(false);
      pending.push({ reconcile: undefined });
    }
    last = event.sequence;
    const scope = workspaceScopeKey(event.workspace);
    if (event.kind === "discard-begin") {
      recoveryTargetsChanged(scope, event.roots);
      discard?.begin(event);
    } else if (event.kind === "discard-end") {
      discard?.end(event);
    } else {
      recoveryTargetsChanged(
        scope,
        event.kind === "deleted" ? event.paths : [event.from, event.to],
      );
      pending.push({ event });
    }
    // Staged by the handlers above, so a read held for this event is judged after.
    mutationFenceAdvance(event.sequence);
    drain();
  }).then(
    (stop) => {
      if (!live) {
        stop();
        return;
      }
      unlisten = stop;
      if (discard)
        void discard.currentSequence().then(
          (sequence) => {
            if (live) mutationFenceLive(sequence);
          },
          () => mutationFenceDown(),
        );
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
        discard?.reset();
        mutationFenceDown();
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
    discard?.reset();
    mutationFenceDown();
    pending.length = 0;
    releasePending?.();
    unlisten?.();
  };
}
