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
