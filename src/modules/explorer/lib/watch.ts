import { toast } from "sonner";
import { watchHealth } from "./watchHealth";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import { authorizationSettled } from "@/modules/workspace/authorize";

const FS_CHANGED_EVENT = "fs:changed";

type FsChangedPayload = { paths: string[] };

export type FsWatchHandles = {
  directories: { path: string; handle: string }[];
  files: { path: string; handle: string }[];
};

export function releaseWatchHandles(handles: string[]): void {
  if (handles.length) void invoke("watch_release", { handles }).catch(() => {});
}

/** Each consumer retains its own acquisitions; removing a path never resolves it
 * again or borrows another consumer's registration. Batch IPC stays batched. */
let nextWatchClient = 0;
export function createFileWatchClient(
  getWorkspace: () => WorkspaceEnv = currentWorkspaceEnv,
) {
  const notice = `file-watch-${++nextWatchClient}`;
  let noticed = false;
  const clearNotice = () => {
    if (noticed) toast.dismiss(notice);
    noticed = false;
  };
  const failed = new Map<() => void, Entry[]>();
  let health: ReturnType<typeof watchHealth.subscribe> | undefined;
  const stopHealth = () => {
    health?.dispose();
    health = undefined;
    failed.clear();
    clearNotice();
  };
  type Entry = { handle?: string; removed: boolean };
  const entries = new Map<string, Entry[]>();
  const key = (kind: string, path: string) => JSON.stringify([kind, path]);
  const removeEntries = (removed: Entry[]) => {
    const handles: string[] = [];
    for (const entry of removed) {
      entry.removed = true;
      if (entry.handle !== undefined) handles.push(entry.handle);
    }
    releaseWatchHandles(handles);
    for (const [retry, held] of failed) {
      if (held.every((entry) => entry.removed)) failed.delete(retry);
    }
    if (!failed.size) clearNotice();
  };
  return {
    add(paths: string[], files: string[] = []) {
      if (!paths.length && !files.length) return;
      const workspace = getWorkspace();
      const acquired = new Map<string, Entry[]>();
      for (const [kind, values] of [
        ["directories", paths],
        ["files", files],
      ] as const) {
        for (const path of values) {
          const id = key(kind, path),
            entry: Entry = { removed: false };
          entries.set(id, [...(entries.get(id) ?? []), entry]);
          acquired.set(id, [...(acquired.get(id) ?? []), entry]);
        }
      }
      health ??= watchHealth.subscribe(
        () => {},
        () => {
          for (const retry of [...failed.keys()]) retry();
        },
      );
      const ownHealth = health;
      const attempt = () => {
        failed.delete(attempt);
        const requested = new Map<string, Entry[]>();
        const livePaths: string[] = [],
          liveFiles: string[] = [];
        for (const [kind, values, live] of [
          ["directories", paths, livePaths],
          ["files", files, liveFiles],
        ] as const) {
          for (const path of new Set(values)) {
            const id = key(kind, path);
            const pending = (acquired.get(id) ?? []).filter(
              (entry) => !entry.removed && entry.handle === undefined,
            );
            requested.set(id, pending);
            for (const _entry of pending) live.push(path);
          }
        }
        if (!livePaths.length && !liveFiles.length) return;
        void ownHealth.ready
          .then(() =>
            Promise.all(
              [...livePaths, ...liveFiles].map((path) =>
                authorizationSettled(path, workspace),
              ),
            ),
          )
          .then(() =>
            invoke<FsWatchHandles>("fs_watch_add", {
              paths: livePaths,
              files: liveFiles,
              workspace,
            }),
          )
          .then((result) => {
            const late: string[] = [];
            for (const kind of ["directories", "files"] as const) {
              for (const { path, handle } of result[kind]) {
                const entry = requested.get(key(kind, path))?.shift();
                if (!entry || entry.removed) late.push(handle);
                else entry.handle = handle;
              }
            }
            releaseWatchHandles(late);
            if (!failed.size) clearNotice();
          })
          .catch((error) => {
            if ([...acquired.values()].flat().every((entry) => entry.removed))
              return;
            failed.set(attempt, [...acquired.values()].flat());
            if (ownHealth.current().error) return;
            noticed = true;
            toast.error("Folder live updates unavailable", {
              id: notice,
              duration: Number.POSITIVE_INFINITY,
              description: String(error),
              action: {
                label: "Retry",
                onClick: () => void watchHealth.retry(),
              },
            });
          });
      };
      attempt();
    },
    remove(paths: string[], files: string[] = []) {
      const removed: Entry[] = [];
      for (const [kind, values] of [
        ["directories", paths],
        ["files", files],
      ] as const) {
        for (const path of values) {
          const id = key(kind, path),
            queue = entries.get(id),
            entry = queue?.shift();
          if (entry) removed.push(entry);
          if (!queue?.length) entries.delete(id);
        }
      }
      removeEntries(removed);
      if (!entries.size) stopHealth();
    },
    dispose() {
      removeEntries([...entries.values()].flat());
      entries.clear();
      stopHealth();
    },
  };
}

export function listenFsChanged(
  handler: (paths: string[]) => void,
): Promise<() => void> {
  return getCurrentWebviewWindow().listen<FsChangedPayload>(
    FS_CHANGED_EVENT,
    (e) => handler(e.payload.paths),
  );
}

/** The folder holding `path`; a drive root keeps its slash (`D:/`, not `D:`). */
export function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) return path.slice(0, i + 1) || path;
  if (i === 2 && /^[A-Za-z]:[\\/]/.test(path)) return path.slice(0, 3);
  return path.slice(0, i);
}
