import type { PreferenceSnapshot } from "@/modules/settings/nativePreferences";
import type { Theme } from "./types";

type Dependencies = {
  preferences: () => Promise<PreferenceSnapshot>;
  themes: () => Promise<{ themes: Theme[] }>;
  isBuiltin: (id: string) => boolean;
  persistDefault: (revision: number) => Promise<void>;
  current: () => boolean;
  notice: () => void;
};

/** Only repair a missing selection after authoritative settings and catalog reads. */
export async function reconcileThemeSelection(id: string, deps: Dependencies): Promise<void> {
  if (deps.isBuiltin(id)) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await deps.preferences();
    if (!deps.current() || snapshot.values.themeId !== id) return;
    const catalog = await deps.themes();
    if (!deps.current() || catalog.themes.some((theme) => theme.id === id)) return;
    try {
      await deps.persistDefault(snapshot.revision);
      deps.notice();
      return;
    } catch (error) {
      if (!String(error).includes("PREFERENCES_REVISION_CHANGED")) throw error;
    }
  }
  throw new Error("Preferences changed repeatedly while restoring the default theme. Select a theme to retry.");
}
