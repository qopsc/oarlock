import { workspaceScopeKey, type WorkspaceEnv } from "@/modules/workspace/env";
import type { DiscardCandidate, DiscardPreparation } from "./documentSession";
import { pathKey } from "@/lib/pathKey";
import type { Tab } from "@/modules/tabs";

/** A git status path (repository-relative) as an absolute path. */
export function repoFilePath(repoRoot: string, path: string): string {
  if (/^([A-Za-z]:)?[\\/]/.test(path)) return path;
  return `${repoRoot.replace(/[\\/]+$/, "")}/${path}`;
}

/** Open editor tabs showing one of `paths` or a file inside one of them. */
export function editorTabsUnder(
  tabs: readonly Tab[],
  paths: readonly string[],
): number[] {
  const roots = paths.map(pathKey);
  return tabs
    .filter((tab) => {
      if (tab.kind !== "editor") return false;
      const key = pathKey(tab.path);
      return roots.some((root) => key === root || key.startsWith(`${root}/`));
    })
    .map((tab) => tab.id);
}

export type DiscardDocument = {
  path: string;
  workspace: WorkspaceEnv;
  stage: (preserve: boolean) => DiscardCandidate;
};
const documents = new Set<DiscardDocument>();
const activeDiscards = new Set<{
  capture: (document: DiscardDocument, preserve: boolean) => void;
}>();

/** Newly mounted documents join a running operation before they can be edited. */
export function registerDiscardDocument(document: DiscardDocument): () => void {
  documents.add(document);
  for (const discard of activeDiscards) discard.capture(document, true);
  return () => {
    documents.delete(document);
  };
}

const headListeners = new Set<() => void>();

/** A commit or pull in Source Control moved HEAD: change gutters are stale. */
export function notifyHeadMoved(): void {
  for (const listener of headListeners) listener();
}

export function onHeadMoved(listener: () => void): () => void {
  headListeners.add(listener);
  return () => {
    headListeners.delete(listener);
  };
}

export type DiscardMatch = (paths: string[]) => Promise<boolean[]>;

/** Native matching is operation-scoped: no identity cache can go stale after
 * symlink retargeting. Candidates hold revisions before the asynchronous read. */
export function prepareNativeDiscard(
  workspace: WorkspaceEnv,
  preserve: boolean,
): DiscardPreparation & {
  ready: (match: DiscardMatch) => Promise<void>;
} {
  const candidates: {
    path: string;
    candidate: DiscardCandidate;
    selected?: DiscardPreparation;
  }[] = [];
  let match: DiscardMatch | undefined;
  let live = true;
  let failed: unknown;
  const pending = new Set<Promise<void>>();
  const select = (batch: typeof candidates) => {
    if (!match || !batch.length) return;
    const lookup = match;
    const task = Promise.resolve()
      .then(() => (live ? lookup(batch.map(({ path }) => path)) : []))
      .then((matches) => {
        if (!live) return;
        if (
          matches.length !== batch.length ||
          matches.some((value) => typeof value !== "boolean")
        )
          throw new Error("Incomplete native document identity response");
        for (let i = 0; i < batch.length; i++)
          batch[i].selected = batch[i].candidate.select(matches[i]);
      })
      .catch((error: unknown) => {
        failed = error ?? new Error("Native document identity lookup failed");
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  };
  const discard = {
    capture: (document: DiscardDocument, keep: boolean) => {
      if (
        workspaceScopeKey(document.workspace) !== workspaceScopeKey(workspace)
      )
        return;
      if (!document.stage)
        throw new Error(
          "Document cannot participate in native Discard matching",
        );
      const candidate = {
        path: document.path,
        candidate: document.stage(keep),
      };
      candidates.push(candidate);
      if (match) select([candidate]);
    },
  };
  for (const document of documents) discard.capture(document, preserve);
  activeDiscards.add(discard);
  const finish = (ok: boolean) => {
    if (!live) return;
    live = false;
    activeDiscards.delete(discard);
    for (const candidate of candidates) {
      // Unknown identity is retained on a failed/cancelled round, never discarded.
      const selected = candidate.selected ?? candidate.candidate.select(true);
      if (ok && candidate.selected) selected.complete();
      else selected.dispose();
    }
  };
  return {
    ready: async (lookup) => {
      if (!match) {
        match = lookup;
        select(candidates.slice());
      }
      while (pending.size) await Promise.all([...pending]);
      if (failed !== undefined) throw failed;
    },
    complete: () => finish(true),
    dispose: () => finish(false),
  };
}
