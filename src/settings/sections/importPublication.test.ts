import { expect, it, vi } from "vitest";
import { ImportGate, importBackground, importThemes, removeBackground } from "./importPublication";
import type { PreferenceSnapshot } from "@/modules/settings/nativePreferences";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const preferences = () => {
  let state: PreferenceSnapshot = { revision: 1, values: { themeId: "before", backgroundKind: "image", backgroundImageId: "old" } };
  const snapshot = async () => ({ revision: state.revision, values: { ...state.values } });
  const change = (values: Record<string, unknown>) => { state = { revision: state.revision + 1, values: { ...state.values, ...values } }; };
  const select = vi.fn(async (id: string, expected: number) => {
    if (state.revision !== expected) throw new Error("PREFERENCES_REVISION_CHANGED");
    change({ themeId: id });
  });
  const publish = vi.fn(async (id: string | null, expected?: number) => {
    if (expected !== undefined && expected !== state.revision) throw new Error("BACKGROUND_NOT_COMMITTED: PREFERENCES_REVISION_CHANGED");
    change({ backgroundKind: id === null ? "none" : "image", backgroundImageId: id });
  });
  return { snapshot, change, select, publish, state: () => state };
};

it("keeps another window's newer theme selection, including selecting the same theme", async () => {
  const prefs = preferences();
  const saving = deferred<void>();
  const gate = new ImportGate(vi.fn());
  const pending = importThemes(gate, { snapshot: prefs.snapshot,
    prepare: async () => ({ themes: ["imported"], errors: [] }), save: () => saving.promise, select: prefs.select });
  await flush();
  prefs.change({ themeId: "before" });
  saving.resolve();
  expect((await pending).outcome).toBe("superseded");
  expect(prefs.state().values.themeId).toBe("before");
});

it("cancel during theme catalog saving permits the catalog but never selects it", async () => {
  const prefs = preferences();
  const saving = deferred<void>();
  const gate = new ImportGate(vi.fn());
  const pending = importThemes(gate, { snapshot: prefs.snapshot,
    prepare: async () => ({ themes: ["imported"], errors: [] }), save: () => saving.promise, select: prefs.select });
  await flush();
  expect(gate.cancel()).toBe(true);
  saving.resolve();
  expect((await pending).outcome).toBe("cancelled");
  expect(prefs.select).not.toHaveBeenCalled();
});

it("a theme publication already in Saving completes after its view closes", async () => {
  const prefs = preferences();
  const publishing = deferred<void>();
  const phases: string[] = [];
  const catalog = new Set<string>();
  const gate = new ImportGate((phase) => phases.push(phase));
  const pending = importThemes(gate, { snapshot: prefs.snapshot,
    prepare: async () => ({ themes: ["imported"], errors: [] }), save: async (themes) => { for (const theme of themes) catalog.add(theme); },
    select: async (id, revision) => { await publishing.promise; await prefs.select(id, revision); } });
  await flush();
  expect(phases).toEqual(["preparing", "saving"]);
  expect(catalog.has("imported")).toBe(true);
  expect(prefs.state().values.themeId).toBe("before");
  expect(gate.cancel()).toBe(false);
  gate.dispose();
  publishing.resolve();
  expect((await pending).outcome).toBe("saved");
  expect(prefs.state().values.themeId).toBe("imported");
  expect(catalog.has(String(prefs.state().values.themeId))).toBe(true);
});

it("cancel during image preparation leaves preferences untouched and removes the candidate", async () => {
  const prefs = preferences();
  const importing = deferred<{ id: string }>();
  const removeFile = vi.fn().mockResolvedValue(undefined);
  const gate = new ImportGate(vi.fn());
  const pending = importBackground("file", gate, { snapshot: prefs.snapshot, latest: prefs.snapshot,
    importFile: () => importing.promise, publish: prefs.publish, removeFile });
  await flush();
  expect(gate.cancel()).toBe(true);
  importing.resolve({ id: "candidate" });
  expect(await pending).toBe("cancelled");
  expect(prefs.publish).not.toHaveBeenCalled();
  expect(prefs.state().values).toMatchObject({ backgroundKind: "image", backgroundImageId: "old" });
  expect(removeFile).toHaveBeenCalledExactlyOnceWith("candidate");
});

it("another window's newer background wins and the unused candidate is removed", async () => {
  const prefs = preferences();
  const importing = deferred<{ id: string }>();
  const removeFile = vi.fn().mockResolvedValue(undefined);
  const pending = importBackground("file", new ImportGate(vi.fn()), { snapshot: prefs.snapshot, latest: prefs.snapshot,
    importFile: () => importing.promise, publish: prefs.publish, removeFile });
  await flush();
  prefs.change({ backgroundKind: "image", backgroundImageId: "newer" });
  importing.resolve({ id: "candidate" });
  expect(await pending).toBe("superseded");
  expect(prefs.state().values.backgroundImageId).toBe("newer");
  expect(removeFile).toHaveBeenCalledExactlyOnceWith("candidate");
});

it("Saving cannot be cancelled and completes after the view is disposed", async () => {
  const prefs = preferences();
  const publishing = deferred<void>();
  const phases: string[] = [];
  const gate = new ImportGate((phase) => phases.push(phase));
  const removeFile = vi.fn().mockResolvedValue(undefined);
  const publish = vi.fn(async (id: string | null, revision?: number) => {
    await publishing.promise;
    await prefs.publish(id, revision);
  });
  const pending = importBackground("file", gate, { snapshot: prefs.snapshot, latest: prefs.snapshot,
    importFile: async () => ({ id: "candidate" }), publish, removeFile });
  await flush();
  expect(phases).toEqual(["preparing", "saving"]);
  expect(gate.cancel()).toBe(false);
  gate.dispose();
  publishing.resolve();
  expect(await pending).toBe("saved");
  expect(prefs.state().values).toMatchObject({ backgroundKind: "image", backgroundImageId: "candidate" });
  expect(removeFile).toHaveBeenCalledExactlyOnceWith("old");
});

it("reclaims a definitely failed candidate and preserves one with an unknown outcome", async () => {
  const prefs = preferences();
  const removeFile = vi.fn().mockResolvedValue(undefined);
  const deps = { snapshot: prefs.snapshot, latest: prefs.snapshot, importFile: async () => ({ id: "candidate" }), removeFile,
    publish: vi.fn().mockRejectedValueOnce(new Error("BACKGROUND_NOT_COMMITTED: disk failure")) };
  await expect(importBackground("file", new ImportGate(vi.fn()), deps)).rejects.toThrow("disk failure");
  expect(removeFile).toHaveBeenCalledExactlyOnceWith("candidate");
  expect(prefs.state().values.backgroundImageId).toBe("old");
  removeFile.mockClear();
  deps.publish.mockRejectedValueOnce(new Error("transport closed"));
  await expect(importBackground("file", new ImportGate(vi.fn()), deps)).rejects.toThrow("transport closed");
  expect(removeFile).not.toHaveBeenCalled();
});

it("removal publishes both fields together and retains the current image on failure", async () => {
  const prefs = preferences();
  const removeFile = vi.fn().mockResolvedValue(undefined);
  const deps = { snapshot: prefs.snapshot, latest: prefs.snapshot, importFile: async () => ({ id: "unused" }), publish: prefs.publish, removeFile };
  expect(await removeBackground(new ImportGate(vi.fn()), deps)).toBe(true);
  expect(prefs.state().values).toMatchObject({ backgroundKind: "none", backgroundImageId: null });
  expect(removeFile).toHaveBeenCalledExactlyOnceWith("old");
});

it("a delayed removal cannot overwrite another window's newer background", async () => {
  const prefs = preferences();
  const captured = await prefs.snapshot();
  const waiting = deferred<PreferenceSnapshot>();
  const removeFile = vi.fn().mockResolvedValue(undefined);
  const pending = removeBackground(new ImportGate(vi.fn()), {
    snapshot: () => waiting.promise, latest: prefs.snapshot,
    importFile: async () => ({ id: "unused" }), publish: prefs.publish, removeFile,
  });
  prefs.change({ backgroundKind: "image", backgroundImageId: "newer" });
  waiting.resolve(captured);
  await expect(pending).rejects.toThrow("PREFERENCES_REVISION_CHANGED");
  expect(prefs.state().values.backgroundImageId).toBe("newer");
  expect(removeFile).not.toHaveBeenCalled();
});

it("ignores preparation failures that arrive after cancellation", async () => {
  const prefs = preferences();
  let rejectTheme!: (error: Error) => void;
  let rejectImage!: (error: Error) => void;
  const themeGate = new ImportGate(vi.fn());
  const imageGate = new ImportGate(vi.fn());
  const theme = importThemes(themeGate, {
    snapshot: prefs.snapshot,
    prepare: () => new Promise((_resolve, reject) => { rejectTheme = reject; }),
    save: async () => {}, select: prefs.select,
  });
  const image = importBackground("file", imageGate, {
    snapshot: prefs.snapshot, latest: prefs.snapshot,
    importFile: () => new Promise((_resolve, reject) => { rejectImage = reject; }),
    publish: prefs.publish, removeFile: vi.fn(),
  });
  await flush();
  themeGate.cancel();
  imageGate.cancel();
  rejectTheme(new Error("late theme error"));
  rejectImage(new Error("late image error"));
  expect((await theme).outcome).toBe("cancelled");
  expect(await image).toBe("cancelled");
  expect(prefs.select).not.toHaveBeenCalled();
  expect(prefs.publish).not.toHaveBeenCalled();
});

it("cleans an interrupted candidate under the lock before the next import", async () => {
  const prefs = preferences();
  const assets = new Set(["old", "orphan"]);
  const order: string[] = [];
  let locked = false;
  const result = await importBackground("file", new ImportGate(vi.fn()), {
    snapshot: prefs.snapshot, latest: prefs.snapshot,
    withLock: async (work) => { locked = true; try { return await work(); } finally { locked = false; } },
    cleanup: async () => { expect(locked).toBe(true); order.push("cleanup"); assets.delete("orphan"); },
    importFile: async () => { expect(locked).toBe(true); order.push("prepare"); assets.add("candidate"); return { id: "candidate" }; },
    publish: async (id, revision) => { expect(locked).toBe(true); order.push("publish"); await prefs.publish(id, revision); },
    removeFile: async (id) => { assets.delete(id); },
  });
  expect(result).toBe("saved");
  expect(order).toEqual(["cleanup", "prepare", "publish"]);
  expect(assets.has("orphan")).toBe(false);
  expect(assets.has(String(prefs.state().values.backgroundImageId))).toBe(true);
});
