import type { WorkspaceEnv } from "@/modules/workspace";
import type { ContentSearchOwner } from "./useContentSearch";
/** Authorization and opening share the result's original owner, across the await. */
export async function authorizeContentHit(
  path: string,
  owner: ContentSearchOwner,
  current: () => boolean,
  authorize: (path: string, env: WorkspaceEnv) => Promise<boolean>,
): Promise<boolean> {
  return current() && (await authorize(path, owner.env)) && current();
}
