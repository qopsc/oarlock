import { authorizationSettled, type WorkspaceEnv } from "@/modules/workspace";
import { onAuthorized } from "@/modules/workspace/authorize";
import { projectTrustStatus } from "./api";

/** The project's trust state once the folder's authorization in flight has settled: the
 *  backend refuses a root the workspace registry does not know yet, so asking first would
 *  leave the window with no open project until an unrelated event. */
export async function statusWhenAuthorized(root: string, env: WorkspaceEnv) {
  await authorizationSettled(root, env).catch(() => undefined);
  return projectTrustStatus(root, env);
}

/** Asks again when this root's authorization succeeds after the status was asked: one that
 *  starts later than the wait above is not seen by it. Returns the unsubscribe. */
export function rerunWhenAuthorized(
  root: string,
  env: WorkspaceEnv,
  rerun: () => void,
): () => void {
  return onAuthorized(root, env, rerun);
}
