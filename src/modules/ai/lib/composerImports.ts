import { beginComposerWork } from "./composerWork";
import type { WorkspaceEnv } from "@/modules/workspace";

export function createComposerImports(
  changed: (busy: boolean) => void = () => {},
) {
  const pending = new Set<ReturnType<typeof beginComposerWork>>();
  return {
    busy: () => pending.size > 0,
    cancel() {
      for (const work of [...pending]) work.cancel();
    },
    begin(chatId: string, workspace: WorkspaceEnv) {
      const work = beginComposerWork(chatId);
      pending.add(work);
      work.onFinish(() => {
        if (pending.delete(work) && pending.size === 0) changed(false);
      });
      if (pending.size === 1) changed(true);
      return Object.assign(work, {
        workspace,
        active: () => pending.has(work) && !work.signal.aborted,
      });
    },
  };
}
export type ComposerImport = ReturnType<
  ReturnType<typeof createComposerImports>["begin"]
> & { admission: Promise<void> };
