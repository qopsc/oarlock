const pending = new Map<string, Set<AbortController>>();

export function beginComposerWork(chatId: string) {
  const controller = new AbortController();
  const work = pending.get(chatId) ?? new Set();
  work.add(controller);
  pending.set(chatId, work);
  let finished = false;
  const cleanups: (() => void)[] = [];
  const finish = () => {
    if (finished) return;
    finished = true;
    work.delete(controller);
    if (!work.size && pending.get(chatId) === work) pending.delete(chatId);
    controller.signal.removeEventListener("abort", finish);
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  };
  controller.signal.addEventListener("abort", finish, { once: true });
  return {
    signal: controller.signal,
    cancel: () => controller.abort(),
    finish,
    onFinish(cleanup: () => void) {
      if (finished) cleanup();
      else cleanups.push(cleanup);
    },
  };
}
export type ComposerWork = ReturnType<typeof beginComposerWork>;

export function cancelComposerWork(chatId: string) {
  for (const work of [...(pending.get(chatId) ?? [])]) work.abort();
}
