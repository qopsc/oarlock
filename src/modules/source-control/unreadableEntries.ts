/** A name that was not valid UTF-8: native commands refuse it and its path is lossy. */
export function isUnreadableEntry(entry: { unreadable?: boolean }): boolean {
  return entry.unreadable === true;
}

/** What bulk Stage, Unstage and Discard may act on. */
export function actionableEntries<T extends { unreadable?: boolean }>(
  entries: readonly T[],
): T[] {
  return entries.filter((entry) => !isUnreadableEntry(entry));
}
