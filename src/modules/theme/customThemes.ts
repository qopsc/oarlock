import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Theme } from "./types";

export type ThemeSnapshot = { revision: number; themes: Theme[] };
const EVENT = "oarlock://custom-themes-changed";
let current: ThemeSnapshot | undefined;
/** Full snapshots can skip revisions; older replies must never restore old state. */
export function newerThemeSnapshot(
  current: ThemeSnapshot | undefined,
  next: ThemeSnapshot,
): ThemeSnapshot {
  return current && current.revision >= next.revision ? current : next;
}
const observers = new Set<(snapshot: ThemeSnapshot) => void>();
function accept(next: ThemeSnapshot) {
  const previous = current;
  current = newerThemeSnapshot(current, next);
  if (current !== previous) for (const observer of observers) observer(current);
  return current;
}
export async function readCustomThemes(): Promise<ThemeSnapshot> {
  return accept(await invoke<ThemeSnapshot>("themes_snapshot"));
}
export async function listCustomThemes(): Promise<Theme[]> {
  return (await readCustomThemes()).themes;
}
export async function saveCustomTheme(theme: Theme): Promise<void> {
  await saveCustomThemes([theme]);
}
/** Native per-ID upsert; independent changes never replace the entire catalog. */
export async function saveCustomThemes(
  themes: readonly Theme[],
): Promise<void> {
  if (themes.length === 0) return;
  accept(
    await invoke<ThemeSnapshot>("themes_mutate", {
      change: { kind: "upsert", themes },
    }),
  );
}
export async function deleteCustomTheme(id: string): Promise<void> {
  accept(
    await invoke<ThemeSnapshot>("themes_mutate", {
      change: { kind: "delete", id },
    }),
  );
}
/** Subscribe before reading so changes during startup cannot be missed. */
export async function watchCustomThemes(
  changed: (snapshot: ThemeSnapshot) => void,
  failed: (error: unknown) => void,
): Promise<UnlistenFn> {
  let alive = true;
  let revision = -1;
  const publish = (snapshot: ThemeSnapshot) => {
    if (!alive || snapshot.revision <= revision) return;
    revision = snapshot.revision;
    changed(snapshot);
  };
  observers.add(publish);
  let stop: UnlistenFn;
  try {
    stop = await listen<ThemeSnapshot>(EVENT, ({ payload }) => {
      if (alive) publish(accept(payload));
    });
  } catch (error) {
    observers.delete(publish);
    throw error;
  }
  // Keep the listener through a failed read so another successful operation can
  // recover the view. Settings can also explicitly reconnect and retry.
  const initialRevision = revision;
  void readCustomThemes().then(publish, (error) => {
    if (alive && revision === initialRevision) failed(error);
  });
  return () => {
    alive = false;
    observers.delete(publish);
    stop();
  };
}
