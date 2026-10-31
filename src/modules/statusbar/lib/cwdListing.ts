import { workspaceScopeKey, type WorkspaceEnv } from "@/modules/workspace";

export type CwdListing = { key: string; children: string[]; error: string | null };
export function cwdListingKey(path: string, showHidden: boolean, workspace: WorkspaceEnv): string {
  return JSON.stringify([workspaceScopeKey(workspace), path, showHidden]);
}
export async function loadCwdListing(
  key: string, read: () => Promise<string[]>, current: () => boolean,
  publish: (result: CwdListing) => void,
): Promise<void> {
  try {
    const children = await read();
    if (current()) publish({ key, children, error: null });
  } catch (error) {
    if (current()) publish({ key, children: [], error: String(error) });
  }
}
