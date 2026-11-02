/** Owns the latest in-flight listing for each directory in one workspace. */
export function createDirectoryReadOrder() {
  const latest = new Map<string, object>();
  return {
    begin(path: string): () => boolean {
      const ticket = {};
      latest.set(path, ticket);
      return () => latest.get(path) === ticket;
    },
    reset(): void { latest.clear(); },
    forget(paths: Iterable<string>): void { for (const path of paths) latest.delete(path); },
  };
}
