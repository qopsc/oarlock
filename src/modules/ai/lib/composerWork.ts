import { beginRun, cancelPreparation } from "./runOwner";

/** Composer work that is not a message turn (voice, imports): a page-only run owner. */
export function beginComposerWork(chatId: string) {
  const owner = beginRun(chatId, { kind: "prepare" });
  return {
    signal: owner.signal,
    cancel: () => owner.cancel("navigated"),
    finish: () => void owner.close("complete"),
    onFinish: (cleanup: () => void) => owner.onPrepared(cleanup),
  };
}
export type ComposerWork = ReturnType<typeof beginComposerWork>;

export const cancelComposerWork = cancelPreparation;
