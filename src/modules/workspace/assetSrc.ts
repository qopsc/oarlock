import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * The backend's guarded scheme checks scope and read limits on every request,
 * preserves the asset scope's dot-folder rule, and validates PDF content.
 */
const ALL_FOLDERS_SCHEME = "oarlock-asset";

/** A host path as a URL the webview loads it from, with the page generation. */
export function assetSrc(
  hostPath: string,
  allFolders: boolean,
  token: string,
): string {
  return `${convertFileSrc(hostPath, ALL_FOLDERS_SCHEME)}?access=${allFolders ? 1 : 0}&t=${encodeURIComponent(token)}`;
}
