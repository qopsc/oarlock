import type { WorkspaceEnv } from "@/modules/workspace/env";

/**
 * Whether input typed now reaches the shell's prompt. A WSL pane cannot be
 * asked about its foreground (the process check sees only the Windows side),
 * so it counts only after shell integration reported the end of a prompt
 * (OSC 133 B) for this shell, and never in the alternate screen. Other panes
 * are judged by the process check and always pass here.
 */
export function shellPromptConfirmed(
  env: WorkspaceEnv,
  state: { promptSeen: boolean; alternateScreen: boolean | undefined },
): boolean {
  if (env.kind !== "wsl") return true;
  return state.promptSeen && state.alternateScreen === false;
}

/**
 * The foreground check behind the breadcrumb, drops and send_to_agent: a pane
 * whose prompt is not confirmed reads as owned by a job without asking native.
 */
export function foregroundJob(
  env: WorkspaceEnv,
  state: { promptSeen: boolean; alternateScreen: boolean | undefined },
  query: () => Promise<boolean | null>,
): Promise<boolean | null> {
  return shellPromptConfirmed(env, state) ? query() : Promise.resolve(true);
}
