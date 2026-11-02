import type { DropShell } from "./quoteShellPath";

type Cached<P> = { pty: P; value: DropShell | null };

/**
 * The shell dialect of one pty, asked once. A restart reuses the session
 * object, so the cache is keyed to the pty: a reply that lands after the pty
 * changed is returned to its caller (whose ownership check then fails) and
 * never stored for the new shell.
 */
export async function cachedShellDialect<P>(
  session: { pty: P | null; dialect: Cached<P> | null },
  pty: P,
  fetch: () => Promise<DropShell | null>,
): Promise<DropShell | null> {
  if (session.dialect?.pty === pty) return session.dialect.value;
  const value = await fetch();
  if (session.pty === pty) session.dialect = { pty, value };
  return value;
}
