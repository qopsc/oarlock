import { usePreferencesStore } from "./preferences";

type Readiness = { hydrated: boolean; syncing: boolean; error: string | null };

/** Hydration retains UI state; execution also needs an up-to-date snapshot. */
export function preferencesReady(state: Readiness): boolean {
  return (
    state.hydrated === true && state.syncing === false && state.error === null
  );
}

export function requireCurrentPreferences(): void {
  const state = usePreferencesStore.getState();
  if (!preferencesReady(state))
    throw new Error(
      state.error
        ? "Preferences could not be synchronized. Retry loading preferences before using AI."
        : "Preferences are still loading or synchronizing. Try again when they are ready.",
    );
}
