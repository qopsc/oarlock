import { pathAtOrUnder } from "@/app/hooks/tabCloseGuards";

export type RecoveryTarget = {
  changed: () => boolean | Promise<boolean>;
  dispose: () => void;
};
type Pending = { path: string; scope: string; changed: boolean };
const pending = new Set<Pending>();
let covered = false;

/** Fed by the window's existing ordered mutation listener, before quit deferral. */
export function recoveryMutationCoverage(ready: boolean): void {
  covered = ready;
  if (!ready) for (const target of pending) target.changed = true;
}
export function recoveryTargetsChanged(
  scope: string,
  paths: readonly string[],
): void {
  for (const target of pending) {
    if (
      target.scope === scope &&
      paths.some((path) => pathAtOrUnder(target.path, path))
    )
      target.changed = true;
  }
}

/** Exists only while recovery is in flight; unrelated environments never invalidate it. */
export function observeRecoveryTarget(
  path: string,
  scope: string,
): RecoveryTarget {
  if (!covered)
    throw new Error(
      "Document updates are unavailable. Retry document synchronization before restoring this draft.",
    );
  const target: Pending = { path, scope, changed: false };
  pending.add(target);
  return {
    changed: () => target.changed,
    dispose: () => {
      pending.delete(target);
    },
  };
}

/** Pair immediate local notifications with authoritative native alias tracking. */
export async function observeNativeRecoveryTarget(
  path: string,
  scope: string,
  native: {
    begin: () => Promise<string>;
    changed: (id: string) => Promise<boolean>;
    end: (id: string) => Promise<unknown>;
  },
): Promise<RecoveryTarget> {
  const local = observeRecoveryTarget(path, scope);
  let id: string;
  try {
    id = await native.begin();
  } catch (error) {
    local.dispose();
    throw error;
  }
  let live = true;
  return {
    changed: async () =>
      !live || !!(await local.changed()) || native.changed(id),
    dispose: () => {
      if (!live) return;
      live = false;
      local.dispose();
      void native
        .end(id)
        .catch((error) =>
          console.warn("Could not release recovery handle", error),
        );
    },
  };
}
