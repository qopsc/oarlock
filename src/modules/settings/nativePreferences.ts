import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PreferenceSnapshot = {
  revision: number;
  values: Record<string, unknown>;
};
type Update = { revision: number; changes: Record<string, unknown> };
type Observer = {
  changed: (snapshot: PreferenceSnapshot) => void;
  failed: (error: unknown) => void;
  pending?: () => void;
};

/** A delta is usable only against its exact predecessor. Gaps require a snapshot. */
export function advancePreferences(
  current: PreferenceSnapshot | undefined,
  update: Update,
): PreferenceSnapshot | undefined {
  if (current && update.revision <= current.revision) return current;
  if (!current || update.revision !== current.revision + 1) return undefined;
  return {
    revision: update.revision,
    values: { ...current.values, ...update.changes },
  };
}
let current: PreferenceSnapshot | undefined;
let wanted = -1;
let generation = 0;
let reading: Promise<PreferenceSnapshot> | undefined;
let connecting: Promise<void> | undefined;
let unlisten: UnlistenFn | undefined;
const observers = new Set<Observer>();
/** Capture the synchronized revision before beginning an asynchronous choice. */
export function currentNativePreferences(): PreferenceSnapshot | undefined {
  return current && current.revision >= wanted ? current : undefined;
}
function accept(snapshot: PreferenceSnapshot) {
  if (current && snapshot.revision <= current.revision) return;
  current = snapshot;
  for (const observer of observers) observer.changed(snapshot);
}
export function readNativePreferences(): Promise<PreferenceSnapshot> {
  if (reading) return reading;
  const owner = generation;
  const pending = (async () => {
    // An event during the first read can name a later revision. Re-read only
    // in that case; ordinary changes carry their fields without another IPC.
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await invoke<PreferenceSnapshot>("preferences_snapshot");
      if (owner !== generation) return snapshot;
      if (snapshot.revision >= wanted) accept(snapshot);
      if (current && current.revision >= wanted) return current;
    }
    throw new Error("Preferences changed during recovery. Retry loading them.");
  })().finally(() => {
    if (reading === pending) reading = undefined;
  });
  reading = pending;
  return pending;
}
function update(delta: Update) {
  wanted = Math.max(wanted, delta.revision);
  if (delta.revision < wanted) return;
  const next = advancePreferences(current, delta);
  if (next) accept(next);
  else {
    for (const observer of observers) observer.pending?.();
    const owner = generation;
    void readNativePreferences().catch((error) => {
      if (owner !== generation) return;
      for (const observer of observers) observer.failed(error);
    });
  }
}
function disconnect() {
  if (observers.size) return;
  unlisten?.();
  unlisten = undefined;
  // A future subscriber must obtain a fresh snapshot after reconnecting.
  generation++;
  reading = undefined;
  current = undefined;
  wanted = -1;
}
export async function watchNativePreferences(
  changed: Observer["changed"],
  failed: Observer["failed"],
  pending?: Observer["pending"],
): Promise<UnlistenFn> {
  const observer = { changed, failed, pending };
  observers.add(observer);
  try {
    const owner = generation;
    connecting ??= (
      unlisten
        ? Promise.resolve()
        : listen<Update>("oarlock://preferences-changed", (event) => {
            if (owner === generation) update(event.payload);
          }).then((stop) => {
            unlisten = stop;
          })
    ).finally(() => {
      connecting = undefined;
    });
    await connecting;
    const snapshot = await readNativePreferences();
    // accept may already have notified this observer. Consumers compare revisions.
    changed(snapshot);
    return () => {
      observers.delete(observer);
      disconnect();
    };
  } catch (error) {
    observers.delete(observer);
    disconnect();
    throw error;
  }
}
export async function mutatePreferences(
  change:
    | { kind: "set"; key: string; value: unknown }
    | { kind: "patch"; key: string; values: Record<string, unknown> }
    | { kind: "background"; imageId: string | null }
    | { kind: "themeselection"; id: string },
  expectedRevision?: number,
): Promise<void> {
  try {
    const result = await invoke<Update>("preferences_mutate", expectedRevision === undefined ? { change } : { change, expectedRevision });
    if (observers.size) update(result);
  } catch (error) {
    if (expectedRevision !== undefined && String(error).includes("PREFERENCES_REVISION_CHANGED")) throw error;
    if (change.kind === "background") throw error;
    const { toast } = await import("sonner");
    toast.error("Could not save preference", { description: String(error) });
    throw error;
  }
}
