import { IS_WINDOWS } from "@/lib/platform";
import type { WorkspaceEnv } from "./env";

/** Availability never rewrites or deletes a space's persisted environment. */
export function workspaceUnavailableReason(
  env: WorkspaceEnv,
  windows = IS_WINDOWS,
): string | null {
  if (env.kind === "wsl" && !windows)
    return "This WSL space is unavailable on this platform. Its tabs and settings are kept for use on Windows. Switch to a local space to continue.";
  return null;
}
export function assertWorkspaceAvailable(env: WorkspaceEnv): void {
  const reason = workspaceUnavailableReason(env);
  if (reason) throw new Error(reason);
}

/** Keep unavailable tabs in storage, but never mount their resource owners. */
export function availableWorkspaceTabs<T extends { spaceId: string }>(
  tabs: T[],
  spaces: readonly { id: string; env: WorkspaceEnv }[],
  windows = IS_WINDOWS,
): T[] {
  const disabled = new Set(
    spaces
      .filter((s) => workspaceUnavailableReason(s.env, windows))
      .map((s) => s.id),
  );
  return disabled.size ? tabs.filter((t) => !disabled.has(t.spaceId)) : tabs;
}
