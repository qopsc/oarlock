import type { Extension } from "@codemirror/state";
import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  cells: [] as unknown[],
  index: 0,
  effects: [] as (() => void)[],
  deps: new Map<number, { deps: unknown[]; cleanup?: () => void }>(),
  acquire: vi.fn(),
  workspace: { kind: "local" },
}));
vi.mock("react", () => ({
  useState: (value: unknown) => {
    const i = fake.index++;
    if (!(i in fake.cells)) fake.cells[i] = value;
    return [
      fake.cells[i],
      (v: unknown) => {
        fake.cells[i] = v;
      },
    ];
  },
  useEffect: (fn: () => undefined | (() => void), deps: unknown[]) => {
    const i = fake.index++,
      old = fake.deps.get(i);
    if (!old || deps.some((d, j) => !Object.is(d, old.deps[j])))
      fake.effects.push(() => {
        old?.cleanup?.();
        const cleanup = fn();
        fake.deps.set(i, { deps, cleanup: cleanup || undefined });
      });
  },
}));
vi.mock("@/modules/workspace/owner", () => ({
  useOwnedWorkspace: () => fake.workspace,
}));
vi.mock("@/modules/workspace/env", () => ({
  workspaceEnvForPath: () => fake.workspace,
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (select: (s: unknown) => unknown) =>
    select({
      lspCustomServers: [],
      lspActivation: { typescript: "enabled", pyright: "enabled" },
    }),
}));
vi.mock("./runtimeStore", () => ({
  useLspRuntimeStore: (select: (s: unknown) => unknown) =>
    select({ generations: {} }),
}));
vi.mock("./sessionManager", () => ({ acquireDocExtension: fake.acquire }));

import { useLspExtension } from "./useLspExtension";

function render(language: string, flush = true) {
  fake.index = 0;
  // biome-ignore lint/correctness/useHookAtTopLevel: controlled hook driver
  const value = useLspExtension("/repo/a.txt", language, true);
  if (flush) effects();
  return value;
}
function effects() {
  for (const fn of fake.effects.splice(0)) fn();
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  fake.cells = [];
  fake.index = 0;
  fake.effects = [];
  fake.deps.clear();
  fake.acquire.mockReset();
});
it("never returns the previous language's extension during rebinding", async () => {
  const extension: Extension = [],
    release = vi.fn();
  fake.acquire
    .mockResolvedValueOnce({ extension, release })
    .mockResolvedValue(null);
  render("ts");
  await flush();
  expect(render("ts")).toBe(extension);
  expect(render("py", false)).toBeNull();
  effects();
  expect(release).toHaveBeenCalledOnce();
  await flush();
  expect(render("py")).toBeNull();
});
it("releases a delayed old-language attachment without installing it", async () => {
  let done: (value: unknown) => void = () => {};
  fake.acquire
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          done = r;
        }),
    )
    .mockResolvedValue(null);
  render("ts");
  render("py");
  const release = vi.fn();
  done({ extension: [], release });
  await flush();
  expect(release).toHaveBeenCalledOnce();
  expect(render("py")).toBeNull();
});
