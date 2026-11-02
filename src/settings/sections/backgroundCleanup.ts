import type { PreferenceSnapshot } from "@/modules/settings/nativePreferences";

type CleanupDeps = {
  stale: (now: number) => Promise<string[]>;
  snapshot: () => Promise<PreferenceSnapshot>;
  barrier: (snapshot: PreferenceSnapshot) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

/** Call only under the import lock. A revision barrier fences older native saves. */
export async function cleanupBackgroundImports(deps: CleanupDeps, now = Date.now()): Promise<void> {
  const stale = await deps.stale(now);
  if (!stale.length) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await deps.snapshot();
    try { await deps.barrier(snapshot); }
    catch (error) {
      if (String(error).includes("PREFERENCES_REVISION_CHANGED")) continue;
      throw error;
    }
    const selected = snapshot.values.backgroundImageId;
    for (const id of stale) if (id !== selected) await deps.remove(id);
    return;
  }
  // A busy preferences store is not evidence that any image is unreferenced.
}

/** Web Locks release when the page goes away and are shared across same-origin windows. */
export function withBackgroundImportLock<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return Promise.reject(new Error("Background imports require cross-window locking on this platform."));
  return navigator.locks.request("oarlock-background-import-v1", { mode: "exclusive" }, work);
}
