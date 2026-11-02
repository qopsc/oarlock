import { beforeEach, expect, it } from "vitest";
import { usePreferencesStore } from "./preferences";
import { preferencesReady, requireCurrentPreferences } from "./readiness";
beforeEach(() =>
  usePreferencesStore.setState({ hydrated: true, syncing: false, error: null }),
);
it.each([{ hydrated: false }, { syncing: true }, { error: "read failed" }])(
  "retained settings do not authorize requests while unresolved: %j",
  (patch) => {
    usePreferencesStore.setState(patch);
    expect(preferencesReady(usePreferencesStore.getState())).toBe(false);
    expect(requireCurrentPreferences).toThrow("Preferences");
    usePreferencesStore.setState({
      hydrated: true,
      syncing: false,
      error: null,
    });
    expect(requireCurrentPreferences).not.toThrow();
  },
);
