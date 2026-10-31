/** Open only the repository resolution that still owns the current context. */
export async function openResolvedGraph<T>(
  resolve: () => Promise<T | null>,
  current: () => boolean,
  open: (repo: T) => void,
): Promise<void> {
  try {
    const repo = await resolve();
    if (repo && current()) open(repo);
  } catch {
    // Resolution errors are handled by the source-control status UI.
  }
}
