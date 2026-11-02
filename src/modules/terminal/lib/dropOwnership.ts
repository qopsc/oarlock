type Session = {
  readonly generation: number;
  readonly pty: unknown;
  readonly input: unknown;
  readonly shellExited: boolean;
  readonly disposed: boolean;
};

/**
 * Whether a drop still belongs to the terminal it was made on. Unlike input
 * ownership it ignores the input, focus and cwd revisions: typing while the
 * drop is prepared, or focusing a pane, queues behind the drop's input slot and
 * must not cancel it.
 */
export function captureDropOwner<T extends Session>(
  session: T,
  current: () => T | undefined,
  navigation: () => boolean,
  signal: AbortSignal,
  stillAllowed: () => boolean,
): () => boolean {
  const { generation, pty, input } = session;
  return () =>
    navigation() &&
    !signal.aborted &&
    current() === session &&
    session.generation === generation &&
    session.pty === pty &&
    session.input === input &&
    !session.shellExited &&
    !session.disposed &&
    stillAllowed();
}
