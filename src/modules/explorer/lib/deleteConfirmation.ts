export type DeleteConfirmation = {
  scope: object;
  paths: string[];
};

/** Only the selection and workspace the user confirmed may be deleted. */
export function confirmedDeletePaths(
  pending: DeleteConfirmation,
  scope: object,
  paths: readonly string[],
): string[] | null {
  if (pending.scope !== scope || pending.paths.length !== paths.length) return null;
  const current = new Set(paths);
  return pending.paths.every((path) => current.has(path)) ? pending.paths : null;
}
