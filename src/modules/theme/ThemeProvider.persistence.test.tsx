import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  setters: [] as ReturnType<typeof vi.fn>[],
  persistMode: vi.fn(),
  persistId: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const setter = vi.fn();
    state.setters.push(setter);
    return [typeof initial === "function" ? initial() : initial, setter];
  },
  useEffect: () => {},
  useCallback: (callback: unknown) => callback,
  useMemo: (callback: () => unknown) => callback(),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (select: (p: unknown) => unknown) => select({ hydrated: true, syncing: false, error: null }),
}));
vi.mock("@/modules/settings/store", () => ({
  DEFAULT_THEME_ID: "oarlock-default",
  setTheme: state.persistMode,
  setThemeId: state.persistId,
}));
vi.mock("./SurfaceLayer", () => ({ SurfaceLayer: () => null }));
vi.mock("./applyTheme", () => ({ applyTheme: vi.fn(), clearTheme: vi.fn() }));
vi.mock("./customThemes", () => ({ readCustomThemes: vi.fn(), watchCustomThemes: vi.fn() }));
vi.mock("@/modules/settings/nativePreferences", () => ({ mutatePreferences: vi.fn(), readNativePreferences: vi.fn() }));
vi.mock("./themes", () => ({
  getBuiltinTheme: () => undefined,
  getDefaultTheme: () => ({ id: "oarlock-default" }),
}));

import { ThemeProvider } from "./ThemeProvider";

beforeEach(() => {
  state.setters.length = 0;
  state.persistMode.mockReset();
  state.persistId.mockReset();
});

it("keeps the committed theme and startup shadow when a selection cannot be saved", async () => {
  state.persistMode.mockRejectedValue(new Error("save failed"));
  state.persistId.mockRejectedValue(new Error("save failed"));
  const view = ThemeProvider({ children: null });
  const selection = view.props.value;
  selection.setMode("light");
  selection.setThemeId("other-theme");
  await Promise.resolve();
  expect(selection.mode).toBe("system");
  expect(selection.themeId).toBe("oarlock-default");
  expect(state.setters[0]).not.toHaveBeenCalled();
  expect(state.setters[1]).not.toHaveBeenCalled();
  expect(state.persistMode).toHaveBeenCalledWith("light");
  expect(state.persistId).toHaveBeenCalledWith("other-theme");
});
