import { invoke } from "@tauri-apps/api/core";
import {
  currentWorkspaceEnv,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "./env";

// The backend refuses files outside the folders it authorized. What the user
// opens, browses or drops is authorized here first; never a path a terminal
// program or an AI reply named on its own, so the AI tools stay refused.

/** A workspace root; a folder browsed; the folder of a file opened. */
type Grant = "root" | "folder" | "file";
const GRANTS: readonly Grant[] = ["root", "folder", "file"];

// Requests for a spelling may be shared while in flight, but must be checked
// again on a later explicit open: a symlink may now name a different target.
const inFlight = new Map<string, Promise<boolean>>();

const keyOf = (grant: Grant, path: string, env: WorkspaceEnv) =>
  `${grant}\u0000${workspaceScopeKey(env)}\u0000${path}`;

function authorize(
  grant: Grant,
  path: string,
  env: WorkspaceEnv,
): Promise<boolean> {
  const key = keyOf(grant, path, env);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = invoke<string>("workspace_authorize", {
    path,
    workspace: env,
    ...(grant !== "root" && { opened: grant }),
  })
    .then(
      () => true,
      () => false,
    )
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

/**
 * Makes a folder a workspace root: one the user opened, or one a restored
 * window works in. A terminal's own folder is checked against its shell
 * first, in the backend (`authorizePtyCwd`).
 */
export function authorizeRoot(
  path: string,
  env: WorkspaceEnv = currentWorkspaceEnv(),
): Promise<boolean> {
  return authorize("root", path, env);
}

/** Lets the file commands reach a folder the user browses. False if they cannot. */
export function authorizeFolder(
  path: string,
  env: WorkspaceEnv = currentWorkspaceEnv(),
): Promise<boolean> {
  return authorize("folder", path, env);
}

/**
 * Lets the file commands reach a file the user opens: the folder it is really
 * in (a link is followed), or the folder it would be in when it is missing.
 */
export function authorizeFileFolder(
  path: string,
  env: WorkspaceEnv = currentWorkspaceEnv(),
): Promise<boolean> {
  return authorize("file", path, env);
}

/**
 * Resolves once no authorization of exactly `path` is in flight, so a read
 * issued right after the user opened something does not overtake it.
 */
export function authorizationSettled(
  path: string,
  env: WorkspaceEnv = currentWorkspaceEnv(),
): Promise<void> {
  const pending = GRANTS.flatMap((grant) => {
    const request = inFlight.get(keyOf(grant, path, env));
    return request ? [request] : [];
  });
  return pending.length === 0
    ? Promise.resolve()
    : Promise.all(pending).then(() => undefined);
}
