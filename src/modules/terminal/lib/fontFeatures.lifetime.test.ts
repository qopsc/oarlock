import { afterEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
  pending: undefined as (() => (() => void)) | undefined,
  defer: false,
  refresh: vi.fn(),
}));
const core = vi.hoisted(() => ({ invoke: vi.fn(), convertFileSrc: (path: string) => path }));
vi.mock("react", () => ({
  useSyncExternalStore: () => 0,
  useState: () => [0, hooks.refresh],
  useLayoutEffect: (effect: () => (() => void)) => {
    if (hooks.defer) hooks.pending = effect;
    else hooks.cleanup = effect();
  },
}));
vi.mock("@tauri-apps/api/core", () => core);
import { fontFeaturesRevision, useFontFeatureStack, withFontFeatures } from "./fontFeatures";

afterEach(() => { hooks.cleanup?.(); hooks.cleanup = undefined; hooks.pending = undefined; hooks.defer = false; hooks.refresh.mockClear(); vi.unstubAllGlobals(); });

it("evicts unused derived faces while retaining a mounted terminal's font", async () => {
  const faces = new Set<{ family: string }>();
  vi.stubGlobal("FontFace", class { constructor(readonly family: string) {} });
  const values: Record<string, string> = {
    "font-family": '"Test Mono"', src: 'url("/font.woff2")',
  };
  vi.stubGlobal("document", {
    baseURI: "https://app.test/",
    styleSheets: [{ href: null, cssRules: [{ cssText: "@font-face {}", style: { getPropertyValue: (key: string) => values[key] ?? "" } }] }],
    fonts: { add: (face: { family: string }) => faces.add(face), delete: (face: { family: string }) => faces.delete(face) },
  });
  const active = useFontFeatureStack('"Test Mono", monospace', 'ss01=100');
  const activeName = /^"([^"]+)"/.exec(active)?.[1];
  for (let i = 0; i < 64; i++) withFontFeatures('"Test Mono", monospace', `"ss01" ${i}`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(faces.size).toBeLessThanOrEqual(33);
  expect([...faces].some((face) => face.family === activeName)).toBe(true);
  hooks.cleanup?.();
  hooks.cleanup = undefined;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(faces.size).toBeLessThanOrEqual(32);
});

it("bounds installed font lookups and prompts blocked requests to retry", async () => {
  const pending: Array<(faces: unknown[]) => void> = [];
  core.invoke.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  vi.stubGlobal("FontFace", class {});
  vi.stubGlobal("document", { baseURI: "https://app.test/", styleSheets: [], fonts: { add: () => {} } });
  for (let i = 0; i < 20; i++) withFontFeatures(`Missing${i}, monospace`, '"ss01" 1');
  await vi.waitFor(() => expect(pending).toHaveLength(16));
  const revision = fontFeaturesRevision();
  pending[0]([]);
  await vi.waitFor(() => expect(fontFeaturesRevision()).toBeGreaterThan(revision));
  withFontFeatures("Missing19, monospace", '"ss01" 1');
  await vi.waitFor(() => expect(pending).toHaveLength(17));
  for (const resolve of pending.slice(1)) resolve([]);
  await Promise.resolve();
});

it("refreshes a render whose derived face was evicted before commit", async () => {
  const faces = new Set<{ family: string }>();
  vi.stubGlobal("FontFace", class { constructor(readonly family: string) {} });
  const values: Record<string, string> = { "font-family": '"Concurrent Mono"', src: 'url("/font.woff2")' };
  vi.stubGlobal("document", {
    baseURI: "https://app.test/",
    styleSheets: [{ href: null, cssRules: [{ cssText: "@font-face {}", style: { getPropertyValue: (key: string) => values[key] ?? "" } }] }],
    fonts: { add: (face: { family: string }) => faces.add(face), delete: (face: { family: string }) => faces.delete(face) },
  });
  hooks.defer = true;
  const result = useFontFeatureStack('"Concurrent Mono", monospace', "ss01=100");
  const oldName = /^"([^"]+)"/.exec(result)?.[1];
  for (let i = 0; i < 64; i++) withFontFeatures('"Concurrent Mono", monospace', `"ss01" ${i}`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect([...faces].some((face) => face.family === oldName)).toBe(false);
  hooks.cleanup = hooks.pending?.();
  expect(hooks.refresh).toHaveBeenCalledOnce();
});

it("removes partially declared faces when a font constructor fails", () => {
  const faces = new Set<object>();
  let count = 0;
  vi.stubGlobal("FontFace", class { constructor() { count += 1; if (count === 2) throw Error("bad face"); } });
  const values: Record<string, string> = { "font-family": '"Broken Mono"', src: 'url("/font.woff2")' };
  const rule = { cssText: "@font-face {}", style: { getPropertyValue: (key: string) => values[key] ?? "" } };
  vi.stubGlobal("document", { baseURI: "https://app.test/", styleSheets: [{ href: null, cssRules: [rule, rule] }], fonts: { add: (face: object) => faces.add(face), delete: (face: object) => faces.delete(face) } });
  expect(() => withFontFeatures('"Broken Mono", monospace', '"ss01" 1')).toThrow("bad face");
  expect(faces.size).toBe(0);
});

it("retries when font lookup throws before returning a promise", async () => {
  let now = 100;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  core.invoke.mockReset().mockImplementationOnce(() => { throw Error("not available"); }).mockResolvedValueOnce([]);
  vi.stubGlobal("FontFace", class {});
  vi.stubGlobal("document", { baseURI: "https://app.test/", styleSheets: [], fonts: { add: () => {} } });
  try {
    withFontFeatures("Throwing Font, monospace", '"ss01" 1');
    await vi.waitFor(() => expect(core.invoke).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    now += 10_001;
    withFontFeatures("Throwing Font, monospace", '"ss01" 1');
    await vi.waitFor(() => expect(core.invoke).toHaveBeenCalledTimes(2));
  } finally {
    clock.mockRestore();
  }
});
