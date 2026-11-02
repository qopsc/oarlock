import { useOwnedWorkspace } from "./owner";
import { invoke } from "@tauri-apps/api/core";
import { assetSrc } from "./assetSrc";
import { useEffect, useState, useSyncExternalStore } from "react";
import { networkPage } from "@/lib/networkPage";
import { useAllFolders } from "./allFolders";
import {
  currentWorkspaceEnv,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "./env";

type PageWindow = Window & { __OARLOCK_NETWORK_PAGE__?: string };

/**
 * The page generation native delivers once the document has loaded. The
 * guarded scheme refuses a URL without it, so a site framed in the preview
 * cannot ask for files by navigating to one.
 */
function pageToken(): string | null {
  return (window as PageWindow).__OARLOCK_NETWORK_PAGE__ || null;
}

function subscribePageToken(notify: () => void): () => void {
  window.addEventListener("oarlock:network-page", notify);
  return () => window.removeEventListener("oarlock:network-page", notify);
}

/**
 * Asset protocol URL of a workspace file. The protocol opens host paths, so
 * a WSL path is mapped to its share or drive path by the backend first;
 * local paths need no IPC.
 */
export async function workspaceAssetUrl(
  path: string,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
  allFolders = false,
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  const token = await networkPage(signal);
  if (workspace.kind !== "wsl") return assetSrc(path, allFolders, token);
  const host = await invoke<string>("fs_host_path", { path, workspace });
  return assetSrc(host, allFolders, token);
}

/**
 * `workspaceAssetUrl` for render: null until the page generation arrives and,
 * for a WSL path, until it is mapped. Follows "Allow the app to access all
 * folders", so a change reloads previews and the guarded scheme checks the
 * updated access setting.
 */
export function useWorkspaceAssetUrl(path: string | null): string | null {
  const workspace = useOwnedWorkspace();
  const allFolders = useAllFolders((s) => s.app);
  const token = useSyncExternalStore(
    subscribePageToken,
    pageToken,
    pageToken,
  );
  const key =
    path === null
      ? null
      : `${workspaceScopeKey(workspace)}\0${allFolders}\0${token}\0${path}`;
  const [mapped, setMapped] = useState<{ key: string; url: string } | null>(
    null,
  );

  useEffect(() => {
    if (path === null || key === null || token === null) return;
    if (workspace.kind !== "wsl") return;
    let cancelled = false;
    workspaceAssetUrl(path, workspace, allFolders).then(
      (url) => {
        if (!cancelled) setMapped({ key, url });
      },
      (e) => console.warn("[workspace] no host path for", path, e),
    );
    return () => {
      cancelled = true;
    };
  }, [path, key, token, workspace, allFolders]);

  if (path === null || token === null) return null;
  if (workspace.kind !== "wsl") return assetSrc(path, allFolders, token);
  return mapped?.key === key ? mapped.url : null;
}
