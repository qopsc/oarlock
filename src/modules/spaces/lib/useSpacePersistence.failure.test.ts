import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  saveState: vi.fn<() => Promise<void>>(),
  saveStore: vi.fn<() => Promise<void>>(),
  persistScrollback: vi.fn(async () => undefined),
  serialize: vi.fn((tabs: unknown[]) => tabs),
}));

vi.mock("react", () => ({
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => unknown) => {
    effect();
  },
}));
vi.mock("./store", () => ({
  saveState: fake.saveState,
  saveSpacesStore: fake.saveStore,
}));
vi.mock("./useSpaces", () => ({
  useSpaces: { getState: () => ({ initialActiveIndex: {} }) },
}));
vi.mock("./serialize", () => ({
  serializeTabs: (tabs: unknown[]) => fake.serialize(tabs),
  isSerializableTab: () => true,
  persistedTerminalLeafIds: () => [],
}));
vi.mock("@/modules/terminal/lib/terminalScrollbackRestore", () => ({
  scrollbackKeyForLeaf: () => undefined,
  terminalScrollback: {
    persist: fake.persistScrollback,
    attachLeafSource: () => () => undefined,
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("document", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  fake.saveState.mockReset();
  fake.saveStore.mockReset();
  fake.persistScrollback.mockClear();
  fake.serialize.mockReset();
  fake.serialize.mockImplementation((tabs) => tabs);
  fake.saveState.mockResolvedValue();
  fake.saveStore.mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  const module = await import("./useSpacePersistence");
  // biome-ignore lint/correctness/useHookAtTopLevel: deterministic lifecycle harness
  module.useSpacePersistence({
    tabs: [{ id: 1, spaceId: "space", kind: "editor" }] as never,
    activeId: 1,
    activeSpaceId: "space",
    enabled: true,
  });
  return module.flushSpaces;
}

it("retries an unchanged snapshot after its state write fails", async () => {
  fake.saveState.mockRejectedValueOnce(new Error("write failed"));
  const flush = await mount();
  await expect(flush()).rejects.toThrow("write failed");
  await expect(flush()).resolves.toBeUndefined();
  expect(fake.saveState).toHaveBeenCalledTimes(2);
  expect(fake.saveStore).toHaveBeenCalledOnce();
});

it("retries an unchanged snapshot after the disk flush fails", async () => {
  fake.saveStore.mockRejectedValueOnce(new Error("disk failed"));
  const flush = await mount();
  await expect(flush()).rejects.toThrow("disk failed");
  await expect(flush()).resolves.toBeUndefined();
  expect(fake.saveState).toHaveBeenCalledTimes(2);
  expect(fake.saveStore).toHaveBeenCalledTimes(2);
});

it("orders overlapping flushes and leaves the queue usable after failure", async () => {
  let reject!: (error: Error) => void;
  fake.saveState.mockImplementationOnce(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  const flush = await mount();
  const first = flush();
  const second = flush();
  await Promise.resolve();
  expect(fake.saveState).toHaveBeenCalledTimes(1);
  reject(new Error("first failed"));
  await expect(first).rejects.toThrow("first failed");
  await expect(second).resolves.toBeUndefined();
  expect(fake.saveState).toHaveBeenCalledTimes(2);
});

it("captures each layout's scrollback keys before a later flush changes them", async () => {
  let key = "";
  fake.persistScrollback.mockImplementationOnce(async () => { key = "first"; });
  fake.persistScrollback.mockImplementationOnce(async () => { key = "second"; });
  fake.serialize.mockImplementation(() => [{ key }]);
  const flush = await mount();
  const first = flush();
  const second = flush();
  await Promise.all([first, second]);
  expect(fake.saveState).toHaveBeenNthCalledWith(1, "space", { tabs: [{ key: "first" }], activeTabIndex: 0 });
  expect(fake.saveState).toHaveBeenNthCalledWith(2, "space", { tabs: [{ key: "second" }], activeTabIndex: 0 });
});

it("flushes the layout even if saving scrollback fails", async () => {
  fake.persistScrollback.mockRejectedValueOnce(new Error("history failed"));
  const flush = await mount();
  await expect(flush()).rejects.toThrow("history failed");
  expect(fake.saveStore).toHaveBeenCalledOnce();
  await expect(flush()).resolves.toBeUndefined();
  expect(fake.saveState).toHaveBeenCalledTimes(1);
});
