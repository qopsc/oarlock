import {
  currentWorkspaceEnv,
  type WorkspaceEnv,
} from "@/modules/workspace/env";
import { create } from "zustand";
import { native, createNative } from "../lib/native";
import { StaleFileError } from "../lib/staleFile";
import { checkWritableCanonical } from "../lib/security";
import { applyEditOps, type EditOp } from "../tools/editOps";

export type QueuedEdit = {
  workspace?: WorkspaceEnv;
  id: string;
  /** Tool that produced the queued mutation. */
  kind: "write_file" | "edit" | "multi_edit" | "create_directory";
  path: string;
  /** Original file content (empty for new files / create_directory). */
  originalContent: string;
  /** Proposed full content after edit (empty for create_directory). */
  proposedContent: string;
  /** True if the file did not exist when the edit was queued. */
  isNewFile: boolean;
  /** The file's version on disk when the edit was queued (`null`: it did not
   *  exist). Apply writes only over a file still at that version. */
  baseVersion: string | null;
  /** The replacements `edit` and `multi_edit` asked for. Apply runs them onto
   *  the running buffer, so several edits to one file all land. */
  edits?: EditOp[];
  /** Human-readable description, used for create_directory. */
  description?: string;
  /** Why the last Apply could not write it; it stays queued until it is
   *  applied or rejected. */
  error?: string;
};

type PlanState = {
  active: boolean;
  queue: QueuedEdit[];
  toggle: () => void;
  enable: () => void;
  disable: () => void;
  enqueue: (q: QueuedEdit) => void;
  removeOne: (id: string) => void;
  clear: () => void;
  /** Apply the edits queued when called, in order, and drain the ones
   * written; a failed edit stays with its error, and edits queued meanwhile
   * stay for the next apply. Returns per-edit results. */
  applyAll: () => Promise<{ id: string; ok: boolean; error?: string }[]>;
};

let nextId = 1;
export function newQueuedEditId(): string {
  return `q-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

export const usePlanStore = create<PlanState>((set, get) => ({
  active: false,
  queue: [],
  toggle: () =>
    set((s) => ({ active: !s.active, queue: s.active ? [] : s.queue })),
  enable: () => set({ active: true }),
  disable: () => set({ active: false, queue: [] }),
  enqueue: (q) =>
    set((s) => ({
      queue: [
        ...s.queue,
        { ...q, workspace: q.workspace ?? currentWorkspaceEnv() },
      ],
    })),
  removeOne: (id) =>
    set((s) => ({ queue: s.queue.filter((q) => q.id !== id) })),
  clear: () => set({ queue: [] }),
  async applyAll() {
    const results: { id: string; ok: boolean; error?: string }[] = [];
    const processed = new Set<string>();
    const files = new Map<string, FileState>();
    for (const q of get().queue) {
      // Rejected or discarded while earlier writes were running.
      if (!get().queue.some((x) => x.id === q.id)) continue;
      processed.add(q.id);
      let state: FileState | undefined;
      try {
        const workspace = q.workspace;
        const client = workspace ? createNative(() => workspace) : native;
        // Checked again where the write happens: a link on the path may
        // have changed since the edit was queued.
        const safety = await checkWritableCanonical(
          q.path,
          client.canonicalize,
        );
        // Rejection may arrive while native path validation is pending.
        if (!get().queue.some((x) => x.id === q.id)) continue;
        if (!safety.ok) {
          results.push({ id: q.id, ok: false, error: safety.reason });
          continue;
        }
        if (q.kind === "create_directory") {
          await client.createDir(safety.canonical);
        } else {
          const key = JSON.stringify([workspace ?? null, safety.canonical]);
          state = files.get(key);
          if (!state) {
            state = await loadFileState(client, safety.canonical);
            files.set(key, state);
          }
          await applyToFile(client, safety.canonical, q, state);
        }
        results.push({ id: q.id, ok: true });
      } catch (e) {
        results.push({
          id: q.id,
          ok: false,
          error: failureText(e) + redoNote(e, state),
        });
      }
    }
    // Edits the agent queued during the writes were not reviewed: keep them.
    set((s) => ({ queue: settleApplied(s.queue, processed, results) }));
    return results;
  },
}));

/** A file as one Apply sees it: the buffer the next queued edit applies onto
 *  and the version a save must replace. `startVersion` is what the file was
 *  when Apply began, which every edit queued against it must match. */
type FileState = {
  content: string | null;
  version: string | null;
  startVersion: string | null;
  refused?: string;
};

type FileClient = Pick<typeof native, "readFile" | "writeFile">;

async function loadFileState(
  client: FileClient,
  path: string,
): Promise<FileState> {
  let read: Awaited<ReturnType<FileClient["readFile"]>>;
  try {
    read = await client.readFile(path, { versioned: true });
  } catch {
    return { content: null, version: null, startVersion: null };
  }
  if (read.kind !== "text" || typeof read.version !== "string") {
    return {
      content: null,
      version: null,
      startVersion: null,
      refused: "binary, oversized or unversioned file refused",
    };
  }
  return {
    content: read.content,
    version: read.version,
    startVersion: read.version,
  };
}

async function applyToFile(
  client: FileClient,
  path: string,
  q: QueuedEdit,
  state: FileState,
): Promise<void> {
  if (state.refused) throw new Error(state.refused);
  if (q.baseVersion !== state.startVersion) throw new StaleFileError(path);
  let candidate = q.proposedContent;
  if (q.edits) {
    if (state.content === null) throw new Error("file no longer exists");
    const applied = applyEditOps(state.content, q.edits);
    if (!applied.ok) throw new Error(applied.error);
    candidate = applied.content;
  }
  try {
    const saved = await client.writeFile(path, candidate, state.version);
    state.content = candidate;
    state.version = saved.version;
  } catch (e) {
    if (e instanceof StaleFileError) state.refused = e.message;
    throw e;
  }
}

/** An edit that failed for its own reason after another edit to the same file landed was
 *  derived from the file as it was: it stays queued, but only to be rejected and asked again. */
function redoNote(e: unknown, state: FileState | undefined): string {
  if (e instanceof StaleFileError || !state) return "";
  return state.version === state.startVersion
    ? ""
    : " Another edit to this file landed first and changed it, so this one has to be rejected and asked for again.";
}

function failureText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The queue after an Apply: written edits leave it, failed ones stay with
 *  their error (a later Apply clears it), the rest are untouched. */
function settleApplied(
  queue: QueuedEdit[],
  processed: ReadonlySet<string>,
  results: readonly { id: string; ok: boolean; error?: string }[],
): QueuedEdit[] {
  const failed = new Map(
    results.filter((r) => !r.ok).map((r) => [r.id, r.error ?? "Write failed"]),
  );
  return queue.flatMap((q) => {
    if (!processed.has(q.id)) return [q];
    const error = failed.get(q.id);
    return error === undefined ? [] : [{ ...q, error }];
  });
}
