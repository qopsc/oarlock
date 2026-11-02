import { beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  states: [] as unknown[], queued: [] as { slot: number; value: unknown }[],
  index: 0, dispose: vi.fn(),
}));
vi.mock("react", async (actual) => ({
  ...(await actual<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = harness.index++;
    if (!(slot in harness.states)) harness.states[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [harness.states[slot], (value: unknown) => { harness.queued.push({ slot, value }); }];
  },
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
}));
vi.mock("@/modules/terminal/lib/terminalSessionApi", () => ({ disposeSession: harness.dispose }));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: { getState: () => ({ terminalPaneLimit: 8, newTabPosition: "end" }) },
}));
vi.mock("@/modules/spaces/lib/useSpaces", () => ({ useSpaces: { getState: () => ({ spaces: [] }) } }));
import { useTabs } from "./useTabs";

beforeEach(() => { harness.states = []; harness.queued = []; harness.index = 0; harness.dispose.mockClear(); });

it("retains queued tabs and disposes the correct panes when React defers publication", () => {
  const tabs = useTabs();
  const newTab = tabs.newTab();
  const newLeaf = tabs.splitActivePane(newTab, "row");
  expect(newLeaf).not.toBeNull();
  expect(tabs.closeActivePane(newTab)).toBe(false);
  expect(harness.dispose).toHaveBeenCalledWith(newLeaf);
  tabs.closeTab(1);
  expect(harness.dispose).toHaveBeenCalledWith(2);
  const updates = harness.queued.filter((update) => update.slot === 0);
  const published = updates[updates.length - 1]?.value as { id: number }[];
  expect(published.map((tab) => tab.id)).toEqual([newTab]);
});

it("returns and disposes a closed tab's active pane before React publishes", () => {
  const tabs = useTabs();
  const other = tabs.newTab();
  expect(tabs.closeActivePane(other)).toBe(true);
  expect(harness.dispose).toHaveBeenCalledWith(4);
  const updates = harness.queued.filter((update) => update.slot === 0);
  const published = updates[updates.length - 1]?.value as { id: number }[];
  expect(published.map((tab) => tab.id)).toEqual([1]);
});
