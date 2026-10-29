/** Streams and approval pauses share these leases; Stop retries failed releases. */
const leases = new Map<string, Set<RunLease>>();
export type RunLease = { release: () => Promise<void> };

export function holdMcpRun(
  chatId: string | null,
  release: () => Promise<void>,
): RunLease {
  let pending: Promise<void> | undefined;
  let released = false;
  const lease: RunLease = {
    release() {
      if (released) return Promise.resolve();
      pending ??= Promise.resolve()
        .then(release)
        .then(() => {
          released = true;
          if (chatId) {
            const held = leases.get(chatId);
            held?.delete(lease);
            if (held?.size === 0) leases.delete(chatId);
          }
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
  if (chatId) {
    const held = leases.get(chatId) ?? new Set();
    held.add(lease);
    leases.set(chatId, held);
  }
  return lease;
}

export function hasMcpRunLeases(chatId: string): boolean {
  return !!leases.get(chatId)?.size;
}

export async function releaseChatMcpRuns(chatId: string): Promise<void> {
  await Promise.all(
    [...(leases.get(chatId) ?? [])].map((lease) => lease.release()),
  );
}
