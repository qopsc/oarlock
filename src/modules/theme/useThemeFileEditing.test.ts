import { expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  edit: undefined as ((request: { action: "edit"; id: string }) => Promise<void>) | undefined,
  warning: vi.fn(),
  open: vi.fn(),
  write: vi.fn(async () => ({ path: "/theme.json", comparison: "different" })),
  compare: vi.fn(async () => "different"),
}));

vi.mock("react", () => ({ useEffect: (effect: () => unknown) => { effect(); } }));
vi.mock("sonner", () => ({ toast: { warning: fake.warning, error: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: async () => () => undefined, setFocus: async () => undefined }),
}));
vi.mock("@/modules/settings/store", () => ({ setThemeId: async () => undefined }));
vi.mock("@/modules/workspace", () => ({ workspaceEnvForPath: () => ({ kind: "local" }) }));
vi.mock("./customThemes", () => ({
  listCustomThemes: async () => [{ id: "theme" }],
  readCustomThemes: vi.fn(), saveCustomTheme: vi.fn(), saveThemeFileSnapshot: vi.fn(),
}));
vi.mock("./themeFileIngest", () => ({ createThemeFileIngest: () => ({ ingest: vi.fn(), dispose: vi.fn() }) }));
vi.mock("./themeFiles", () => ({
  onThemeEdit: async (handler: typeof fake.edit) => { fake.edit = handler; return () => undefined; },
  themeFilePath: async () => "/theme.json",
  writeThemeFile: fake.write,
  compareThemeFile: fake.compare,
  isThemeFilePath: () => true,
  parseThemeFile: vi.fn(), starterTheme: vi.fn(),
}));

import { useThemeFileEditing } from "./useThemeFileEditing";

it("opens the preserved existing file and warns when it differs from the catalog", async () => {
  useThemeFileEditing({ tabsRef: { current: [] }, openFileTab: fake.open });
  await fake.edit?.({ action: "edit", id: "theme" });
  expect(fake.write).toHaveBeenCalledOnce();
  expect(fake.warning).toHaveBeenCalledWith("Existing theme file differs from the saved theme", expect.anything());
  expect(fake.open).toHaveBeenCalledWith("/theme.json");
});

it("compares an already-open editor without attempting to create its file", async () => {
  fake.write.mockClear();
  fake.warning.mockClear();
  useThemeFileEditing({ tabsRef: { current: [{ kind: "editor", path: "/theme.json" }] as never }, openFileTab: fake.open });
  await fake.edit?.({ action: "edit", id: "theme" });
  expect(fake.write).not.toHaveBeenCalled();
  expect(fake.compare).toHaveBeenCalledOnce();
  expect(fake.warning).toHaveBeenCalled();
});
