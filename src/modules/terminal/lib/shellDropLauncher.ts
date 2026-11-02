import type { ShellDropRun } from "./shellPathDrop";

/**
 * Loads the drop code on first use and runs it. The caller reserved the input
 * slot, so a failed load releases it as well.
 */
export function launchShellDrop(
  run: ShellDropRun,
  load: () => Promise<{ runShellDrop: (run: ShellDropRun) => Promise<void> }> = () =>
    import("./shellPathDrop"),
): void {
  void load()
    .then(({ runShellDrop }) => runShellDrop(run))
    .catch((error: unknown) => {
      run.finish(() => run.refuse(String(error)));
    });
}
