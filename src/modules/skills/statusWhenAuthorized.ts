import { authorizationSettled, type WorkspaceEnv } from "@/modules/workspace";
import { projectTrustStatus } from "./api";

/** The project's trust state once the folder's authorization in flight has settled: the
 *  backend refuses a root the workspace registry does not know yet, so asking first would
 *  leave the window with no open project until an unrelated event. */
export async function statusWhenAuthorized(root: string, env: WorkspaceEnv) {
  await authorizationSettled(root, env).catch(() => undefined);
  return projectTrustStatus(root, env);
}
