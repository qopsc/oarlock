import { beforeEach, expect, it, vi } from "vitest";
import type { Tab } from "@/modules/tabs";

const fake = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  busy: vi.fn(),
}));
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useLayoutEffect: (fn: () => void) => fn(),
  useRef: (value: unknown) => {
    const index = fake.cursor++;
    if (fake.slots[index] === undefined) fake.slots[index] = { current: value };
    return fake.slots[index];
  },
  useState: (value: unknown) => {
    const index = fake.cursor++;
    if (!(index in fake.slots)) fake.slots[index] = value;
    return [fake.slots[index], (next: unknown) => { fake.slots[index] = next; }];
  },
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: { getState: () => ({ confirmCloseRunningTerminal: true }) },
}));
vi.mock("@/modules/terminal", () => ({
  leafIds: () => [30],
  leafHasForegroundProcess: fake.busy,
}));
vi.mock("@/modules/tabs", () => ({
  nextActiveInSpace: () => 1,
  planCloseTabsToRight: () => ({ closeIds: [2, 3], nextActiveId: 1 }),
  planCloseOtherTabs: () => ({ closeIds: [2, 3], nextActiveId: 1 }),
}));
import { useTabCloseGuards } from "./useTabCloseGuards";

const tabs = [
  { id: 1, kind: "editor", spaceId: "s", dirty: false },
  { id: 2, kind: "editor", spaceId: "s", dirty: true },
  { id: 3, kind: "terminal", spaceId: "s", paneTree: {} },
] as Tab[];
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => {
  fake.slots = [];
  fake.cursor = 0;
  fake.busy.mockReset().mockResolvedValue(false);
});

it.each(["before confirmation", "during the terminal check"])(
  "bulk close asks again when a dirty editor changes %s",
  async (when) => {
    let revision = "old";
    const disposeTabs = vi.fn();
    const params = {
      tabs, activeId: 1,
      editorIsDirty: (id: number) => id === 2,
      editorCloseRevision: () => revision,
      disposeTab: vi.fn(), disposeDeletedTabs: vi.fn(), disposeTabs,
    };
    const render = () => { fake.cursor = 0; return useTabCloseGuards(params); };
    render().handleCloseOtherTabs(1);
    await settle();
    expect(render().pendingCloseMany?.dirtyIds).toEqual([2]);
    let release!: (value: boolean) => void;
    fake.busy.mockReturnValueOnce(new Promise<boolean>((resolve) => { release = resolve; }));
    if (when === "before confirmation") revision = "new";
    const confirmation = render().confirmCloseMany();
    if (when === "during the terminal check") revision = "new";
    release(false);
    await confirmation;
    expect(disposeTabs).not.toHaveBeenCalled();
    expect(render().pendingCloseMany?.dirtyIds).toEqual([2]);
    await render().confirmCloseMany();
    expect(disposeTabs).toHaveBeenCalledOnce();
    expect(render().pendingCloseMany).toBeNull();
  },
);

it("does not reconfirm an editor that was saved during the check", async () => {
  let dirty = true;
  const disposeTabs = vi.fn();
  const params = {
    tabs, activeId: 1, editorIsDirty: (id: number) => id === 2 && dirty,
    editorCloseRevision: () => "old",
    disposeTab: vi.fn(), disposeDeletedTabs: vi.fn(), disposeTabs,
  };
  const render = () => { fake.cursor = 0; return useTabCloseGuards(params); };
  render().handleCloseOtherTabs(1);
  await settle();
  let release!: (value: boolean) => void;
  fake.busy.mockReturnValueOnce(new Promise<boolean>((resolve) => { release = resolve; }));
  const confirmation = render().confirmCloseMany();
  dirty = false;
  release(false);
  await confirmation;
  expect(disposeTabs).toHaveBeenCalledOnce();
});
