import { useOwnedWorkspace } from "./owner";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useAllFolders } from "./allFolders";
import {
  currentWorkspaceEnv,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "./env";

/**
 * The backend's guarded scheme checks scope and read limits on every request,
 * preserves the asset scope's dot-folder rule, and validates PDF content.
 */
const ALL_FOLDERS_SCHEME = "oarlock-asset";

/** A host path as a URL the webview loads it from. */
function assetSrc(hostPath: string, allFolders: boolean): string {
  return `${convertFileSrc(hostPath, ALL_FOLDERS_SCHEME)}?access=${allFolders ? 1 : 0}`;
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
): Promise<string> {
  if (workspace.kind !== "wsl") return assetSrc(path, allFolders);
  const host = await invoke<string>("fs_host_path", { path, workspace });
  return assetSrc(host, allFolders);
}

/**
 * `workspaceAssetUrl` for render: null until a WSL path is mapped. Follows
 * "Allow the app to access all folders", so a change reloads previews and
 * the guarded scheme checks the updated access setting.
 */
export function useWorkspaceAssetUrl(path: string | null): string | null {
  const workspace = useOwnedWorkspace();
  const allFolders = useAllFolders((s) => s.app);
  const key =
    path === null
      ? null
      : `${workspaceScopeKey(workspace)}\0${allFolders}\0${path}`;
  const [mapped, setMapped] = useState<{ key: string; url: string } | null>(
    null,
  );

  useEffect(() => {
    if (path === null || key === null || workspace.kind !== "wsl") return;
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
  }, [path, key, workspace, allFolders]);

  if (path === null) return null;
  if (workspace.kind !== "wsl") return assetSrc(path, allFolders);
  return mapped?.key === key ? mapped.url : null;
}
