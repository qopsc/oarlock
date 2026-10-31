import { expect, it, vi } from "vitest";
import { ImportGate, importThemes } from "@/settings/sections/importPublication";
import { reconcileThemeSelection } from "./reconcileThemeSelection";
import type { Theme } from "./types";

const theme = (id: string): Theme => ({ id, name: id, variants: { dark: {} } });

it("repairs a theme deleted immediately before an imported selection and shows a notice", async () => {
  let revision = 1;
  let selected = "old";
  const catalog = new Map([["old", theme("old")]]);
  const notice = vi.fn();
  await importThemes(new ImportGate(() => {}), {
    snapshot: async () => ({ revision, values: { themeId: selected } }),
    prepare: async () => ({ themes: [theme("new")], errors: [] }),
    save: async (themes) => { for (const entry of themes) catalog.set(entry.id, entry); catalog.delete("new"); },
    select: async (entry) => { selected = entry.id; revision++; },
  });
  expect(catalog.has(selected)).toBe(false);
  await reconcileThemeSelection(selected, {
    preferences: async () => ({ revision, values: { themeId: selected } }),
    themes: async () => ({ themes: [...catalog.values()] }),
    isBuiltin: (id) => id === "default",
    persistDefault: async (expected) => { expect(expected).toBe(revision); selected = "default"; revision++; },
    current: () => true,
    notice,
  });
  expect(selected).toBe("default");
  expect(notice).toHaveBeenCalledOnce();
});

it("does not replace a newer choice or repair from an out-of-date catalog", async () => {
  const persistDefault = vi.fn();
  const notice = vi.fn();
  const base = { isBuiltin: () => false, persistDefault, current: () => true, notice };
  await reconcileThemeSelection("missing", {
    ...base, preferences: async () => ({ revision: 2, values: { themeId: "newer" } }),
    themes: async () => ({ themes: [] }),
  });
  await reconcileThemeSelection("missing", {
    ...base, preferences: async () => ({ revision: 2, values: { themeId: "missing" } }),
    themes: async () => ({ themes: [theme("missing")] }),
  });
  expect(persistDefault).not.toHaveBeenCalled();
  expect(notice).not.toHaveBeenCalled();
});

it("preserves a newer preference when it changes during reconciliation", async () => {
  const notice = vi.fn();
  let selected = "missing";
  await reconcileThemeSelection("missing", {
    preferences: async () => ({ revision: 2, values: { themeId: selected } }),
    themes: async () => ({ themes: [] }), isBuiltin: () => false, current: () => true,
    persistDefault: async () => { selected = "newer"; throw new Error("PREFERENCES_REVISION_CHANGED"); }, notice,
  });
  expect(notice).not.toHaveBeenCalled();
});

it("retries when an unrelated preference changed during reconciliation", async () => {
  let revision = 2;
  const notice = vi.fn();
  const persistDefault = vi.fn(async (expected: number) => {
    if (expected === 2) { revision++; throw new Error("PREFERENCES_REVISION_CHANGED"); }
  });
  await reconcileThemeSelection("missing", {
    preferences: async () => ({ revision, values: { themeId: "missing" } }),
    themes: async () => ({ themes: [] }), isBuiltin: () => false, current: () => true,
    persistDefault, notice,
  });
  expect(persistDefault).toHaveBeenCalledTimes(2);
  expect(notice).toHaveBeenCalledOnce();
});
