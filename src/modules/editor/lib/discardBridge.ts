import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceEnv } from "@/modules/workspace/env";
import { prepareNativeDiscard } from "./gitSignals";

/** Source Control Discard from this window. Every mounted document is staged at
 * confirmation, before any IPC; native names the entries it will rewrite, the
 * matching documents (by native-resolved identity) take ownership, and Git runs.
 * Only a buffer unchanged since confirmation is replaced. Other windows hear the
 * same discard as `discard-begin` and `discard-end` on the mutation stream. */
export async function discardAcrossWindows(
  repoRoot: string,
  entries: { path: string; untracked: boolean }[],
  workspace: WorkspaceEnv,
): Promise<void> {
  const round = prepareNativeDiscard(workspace, false);
  try {
    const roots = await invoke<string[]>("git_discard_scope", {
      repoRoot,
      entries,
      workspace,
    });
    await round.ready((paths) =>
      invoke<boolean[]>("git_discard_match", { roots, paths, workspace }),
    );
    await invoke("git_discard", { repoRoot, entries, roots, workspace });
  } catch (error) {
    round.dispose();
    throw error;
  }
  round.complete();
}
