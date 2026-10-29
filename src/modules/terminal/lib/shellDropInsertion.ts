/** Conservative complete-command subset. Never infer raw readline/PSReadLine state. */
export function safeDropBoundary(
  text: string,
  from: number,
  to: number,
): boolean {
  if (from < 0 || to < from || to > text.length) return false;
  const before = text.slice(0, from);
  const after = text.slice(to);
  // Quotes, substitutions, continuations and compound commands need a real
  // shell parser. Fail closed; the user can finish or simplify the command.
  const plain = /^[a-zA-Z0-9_ /.,:=+-]*$/;
  return (
    plain.test(before) &&
    plain.test(after) &&
    (before.length === 0 || before.endsWith(" ")) &&
    (after.length === 0 || after.startsWith(" "))
  );
}

/** Capture exact editor state, not just equal text (edit/undo also cancels). */
export function captureDropInsertion<T>(
  state: T,
  current: () => T | undefined,
  text: string,
  ranges: readonly { from: number; to: number }[],
  insert: (text: string) => void,
): ((text: string) => boolean) | null {
  if (
    ranges.length !== 1 ||
    !safeDropBoundary(text, ranges[0].from, ranges[0].to)
  )
    return null;
  return (value) => {
    if (current() !== state) return false;
    insert(value);
    return true;
  };
}
