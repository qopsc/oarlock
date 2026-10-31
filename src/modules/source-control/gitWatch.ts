import { toast } from "sonner";
import { watchHealth } from "@/modules/explorer/lib/watchHealth";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { WorkspaceEnv } from "@/modules/workspace";

type GitChangedPayload = { repoRoots: string[] };

/**
 * Watches `repoRoot` (its git directory and the watched folders of its work
 * tree) for as long as a Source Control view of it is on screen.
 */
let nextGitWatch = 0;
export function gitWatchAdd(
  repoRoot: string,
  workspace: WorkspaceEnv,
): () => void {
  let disposed = false;
  let handle: string | undefined;
  let pending = false;
  let noticed = false;
  const clearNotice = () => {
    if (noticed) toast.dismiss(notice);
    noticed = false;
  };
  const notice = `git-watch-${++nextGitWatch}`;
  const health = watchHealth.subscribe(
    () => {},
    () => {
      if (handle === undefined) attempt();
    },
  );
  const release = (handle: string) => {
    void invoke("watch_release", { handles: [handle] }).catch(() => {});
  };
  const attempt = () => {
    if (disposed || pending) return;
    pending = true;
    void health.ready
      .then(() => invoke<string>("git_watch_add", { repoRoot, workspace }))
      .then((id) => {
        if (disposed) release(id);
        else {
          handle = id;
          clearNotice();
        }
      })
      .catch((error) => {
        if (!disposed && !health.current().error) {
          noticed = true;
          toast.error("Source Control live updates unavailable", {
            id: notice,
            duration: Number.POSITIVE_INFINITY,
            description: String(error),
            action: { label: "Retry", onClick: () => void watchHealth.retry() },
          });
        }
      })
      .finally(() => {
        pending = false;
      });
  };
  attempt();
  return () => {
    if (disposed) return;
    disposed = true;
    health.dispose();
    clearNotice();
    if (handle !== undefined) release(handle);
  };
}

/** `repoRoots` are spelled as they were passed to `gitWatchAdd`. */
export function listenGitChanged(
  handler: (repoRoots: string[]) => void,
): Promise<() => void> {
  return getCurrentWebviewWindow().listen<GitChangedPayload>(
    "git:changed",
    (e) => handler(e.payload.repoRoots),
  );
}
