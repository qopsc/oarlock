import { expect, it, vi } from "vitest";
import { isStaleBgImage } from "@/modules/theme/bgImageStore";
import { cleanupBackgroundImports } from "./backgroundCleanup";
import type { PreferenceSnapshot } from "@/modules/settings/nativePreferences";

it("only identifies our old, well-formed staging keys", () => {
  const id = "oarlock-stage-v1-1700000000000-9f82bac3-5045-48b3-830d-e5b742aaad34";
  expect(isStaleBgImage(id, 1_700_000_060_000)).toBe(true);
  expect(isStaleBgImage(id, 1_700_000_059_999)).toBe(false);
  expect(isStaleBgImage("9f82bac3-5045-48b3-830d-e5b742aaad34", 1_800_000_000_000)).toBe(false);
  expect(isStaleBgImage(`${id}-extra`, 1_800_000_000_000)).toBe(false);
});

it.each([false, true])("interruption after publication = %s keeps the selection valid", async (published) => {
  let state: PreferenceSnapshot = { revision: 1, values: { themeId: "default", backgroundImageId: published ? "candidate" : "old" } };
  const assets = new Set(["old", "candidate"]);
  await cleanupBackgroundImports({
    stale: async () => ["candidate"],
    snapshot: async () => structuredClone(state),
    barrier: async (snapshot) => { expect(snapshot.revision).toBe(state.revision); state = { ...state, revision: state.revision + 1 }; },
    remove: async (id) => { assets.delete(id); },
  });
  expect(assets.has(String(state.values.backgroundImageId))).toBe(true);
  expect(assets.has("candidate")).toBe(published);
});

it("fences a delayed native publication before removing its orphan", async () => {
  let revision = 7;
  let selected = "old";
  const remove = vi.fn();
  const delayedPublication = (expected: number) => {
    if (expected !== revision) throw new Error("PREFERENCES_REVISION_CHANGED");
    selected = "candidate";
  };
  await cleanupBackgroundImports({
    stale: async () => ["candidate"],
    snapshot: async () => ({ revision, values: { backgroundImageId: selected } }),
    barrier: async (snapshot) => { expect(snapshot.revision).toBe(revision); revision++; },
    remove,
  });
  expect(remove).toHaveBeenCalledExactlyOnceWith("candidate");
  expect(() => delayedPublication(7)).toThrow("PREFERENCES_REVISION_CHANGED");
  expect(selected).toBe("old");
});

it("retries a concurrent selection instead of deleting its image", async () => {
  let revision = 1;
  let selected = "old";
  const remove = vi.fn();
  await cleanupBackgroundImports({
    stale: async () => ["candidate"],
    snapshot: async () => ({ revision, values: { backgroundImageId: selected } }),
    barrier: async (snapshot) => {
      if (revision === 1) { revision++; selected = "candidate"; }
      if (snapshot.revision !== revision) throw new Error("PREFERENCES_REVISION_CHANGED");
      revision++;
    },
    remove,
  });
  expect(selected).toBe("candidate");
  expect(remove).not.toHaveBeenCalled();
});
