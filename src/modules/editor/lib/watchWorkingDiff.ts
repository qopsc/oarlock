import {
  watchHealth,
  type WatchHealth,
} from "@/modules/explorer/lib/watchHealth";
import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceEnv } from "@/modules/workspace/env";
import { authorizationSettled } from "@/modules/workspace/authorize";
import { listenGitChanged } from "@/modules/source-control/gitWatch";
import {
  type FsWatchHandles,
  listenFsChanged,
  parentDir,
} from "@/modules/explorer/lib/watch";
import { repoFilePath } from "./gitSignals";
import { pathKey } from "@/lib/pathKey";

/** Register listeners first and release late watch acquisitions even after unmount. */
export function watchWorkingDiff(
  repoRoot: string,
  path: string,
  workspace: WorkspaceEnv,
  changed: () => void,
  healthChanged: (health: WatchHealth) => void = () => {},
) {
  const file = repoFilePath(repoRoot, path);
  const paths = [...new Set([repoRoot, parentDir(file)])];
  const matching = new Set([pathKey(file), ...paths.map(pathKey)]);
  let disposed = false;
  const releases: (() => unknown)[] = [];
  const release = (fn: () => unknown) => {
    void Promise.resolve()
      .then(fn)
      .catch(() => {});
  };
  const retain = (fn: () => unknown) => {
    if (disposed) release(fn);
    else releases.push(fn);
  };
  let registered = false;
  const health = watchHealth.subscribe((status) => {
    if (registered && !disposed) healthChanged(status);
  });
  retain(health.dispose);
  const ready = (async () => {
    await health.ready;
    if (disposed) return;
    retain(
      await listenGitChanged((roots) => {
        if (!disposed && roots.includes(repoRoot)) changed();
      }),
    );
    if (disposed) return;
    retain(
      await listenFsChanged((paths) => {
        if (!disposed && paths.some((p) => matching.has(pathKey(p)))) changed();
      }),
    );
    if (disposed) return;
    await authorizationSettled(file, workspace);
    if (disposed) return;
    const gitHandle = await invoke<string>("git_watch_add", {
      repoRoot,
      workspace,
    });
    retain(() => invoke("watch_release", { handles: [gitHandle] }));
    if (disposed) return;
    const result = await invoke<FsWatchHandles>("fs_watch_add", {
      paths,
      files: [file],
      workspace,
    });
    const handles = [...result.directories, ...result.files].map(
      (entry) => entry.handle,
    );
    if (handles.length) retain(() => invoke("watch_release", { handles }));
    if (disposed) return;
    await health.refresh();
    registered = true;
  })();
  return {
    ready,
    health: health.current,
    dispose() {
      disposed = true;
      for (const fn of releases.splice(0).reverse()) release(fn);
    },
  };
}
