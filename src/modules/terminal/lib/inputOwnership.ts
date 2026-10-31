import type { WorkspaceEnv } from "@/modules/workspace/env";

type Session = {
  readonly workspace: WorkspaceEnv;
  readonly generation: number;
  readonly inputRevision: number;
  readonly cwdRevision: number;
  readonly lastCwd: string | null;
  readonly initialCwd: string | undefined;
  readonly focusRevision: number;
  readonly pty: { id: number } | null;
  readonly disposed: boolean;
  readonly shellExited: boolean;
};

/** App-generated input belongs to one terminal and one navigation context. */
export function captureInputOwner<T extends Session>(
  session: T | undefined,
  current: () => T | undefined,
  navigation: () => boolean,
) {
  if (!session || session.disposed || session.shellExited) return null;
  const pty = session.pty;
  const { generation, inputRevision, cwdRevision, focusRevision } = session;
  const awaitingInitialCwd = session.lastCwd === null;
  return {
    workspace: session.workspace,
    pty,
    active: () => navigation() && current() === session && !session.disposed &&
      !session.shellExited && session.generation === generation &&
      session.inputRevision === inputRevision &&
      (session.cwdRevision === cwdRevision ||
        (awaitingInitialCwd && session.cwdRevision === cwdRevision + 1 &&
          (!session.initialCwd || session.lastCwd === session.initialCwd))) &&
      session.focusRevision === focusRevision && (!pty || session.pty === pty),
  };
}
