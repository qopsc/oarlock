import type { WorkspaceEnv } from "@/modules/workspace/env";
import type { DropShell } from "./quoteShellPath";

type Session = {
  readonly workspace: WorkspaceEnv;
  lastCwd: string | null;
  cwdRevision: number;
  pty: { id: number } | null;
  generation: number;
  disposed: boolean;
  shellExited: boolean;
};

/** Snapshot the terminal itself, not the window's current workspace. */
export function captureCompletionOwner<T extends Session>(
  session: T | undefined,
  current: () => T | undefined,
  navigation: () => boolean,
  atPrompt: () => boolean,
  verify: (id: number, cwd: string, workspace: WorkspaceEnv) => Promise<DropShell>,
) {
  const pty = session?.pty;
  const cwd = session?.lastCwd;
  if (!session || !pty || !cwd || session.disposed || session.shellExited) return null;
  const generation = session.generation;
  const cwdRevision = session.cwdRevision;
  const active = () => navigation() && current() === session && !session.disposed &&
    !session.shellExited && session.pty === pty && session.generation === generation &&
    session.lastCwd === cwd && session.cwdRevision === cwdRevision && atPrompt();
  return {
    cwd,
    workspace: session.workspace,
    active,
    verify: async () => {
      if (!active()) throw Error("Terminal changed");
      const shell = await verify(pty.id, cwd, session.workspace);
      if (!active()) throw Error("Terminal changed");
      return shell;
    },
  };
}
