/** Work which must settle before a stopped chat may start another turn. */
const pending = new Map<string, Set<Promise<unknown>>>();
export function beginChatWork(id: string | null): () => void {
  if (!id) return () => {};
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const work = pending.get(id) ?? new Set();
  work.add(promise);
  pending.set(id, work);
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    finish();
    work.delete(promise);
    if (work.size === 0 && pending.get(id) === work) pending.delete(id);
  };
}
export async function drainChatWork(id: string): Promise<void> {
  for (;;) {
    const work = pending.get(id);
    if (!work?.size) return;
    await Promise.all([...work]);
  }
}
