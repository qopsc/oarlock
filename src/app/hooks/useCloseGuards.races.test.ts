import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EffectCallback } from "react";
import type { QuitRequest, QuitResume } from "./quitApproval";
import type { Tab } from "@/modules/tabs";

const fake = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  cleanups: [] as (() => void)[],
  states: [] as unknown[],
  onClose: undefined as
    | undefined
    | ((event: { preventDefault: () => void }) => Promise<void>),
  onQuit: undefined as
    | undefined
    | ((event: { payload: QuitRequest }) => Promise<void>),
  onResume: undefined as undefined | ((event: { payload: QuitResume }) => void),
  toast: vi.fn(),
  close: vi.fn(),
  flush: vi.fn(),
  count: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useRef: (current: unknown) => ({ current }),
  useEffect: (fn: EffectCallback) =>
    fake.effects.push(() => {
      const cleanup = fn();
      if (typeof cleanup === "function") fake.cleanups.push(cleanup);
      return cleanup;
    }),
  useLayoutEffect: (fn: EffectCallback) => fn(),
  useState: (initial: unknown) => {
    const index = fake.states.length;
    fake.states.push(initial);
    return [
      initial,
      (value: unknown) => {
        fake.states[index] = value;
      },
    ];
  },
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({ confirmCloseRunningTerminal: false }),
  },
}));
vi.mock("@/modules/terminal", () => ({
  leafIds: () => [],
  leafHasForegroundProcess: vi.fn(),
}));
vi.mock("@/modules/tabs", () => ({
  nextActiveInSpace: () => 1,
  planCloseTabsToRight: () => ({ closeIds: [2], nextActiveId: 1 }),
  planCloseOtherTabs: () => ({ closeIds: [2], nextActiveId: 1 }),
}));
vi.mock("sonner", () => ({ toast: { error: fake.toast, info: fake.toast } }));
vi.mock("@/modules/ai/store/chatStore", () => ({ flushPersist: vi.fn() }));
vi.mock("@/modules/ai/lib/sessions", () => ({
  flushSessionWrites: fake.flush,
}));
vi.mock("@/modules/spaces/lib/useSpacePersistence", () => ({
  flushSpaces: vi.fn(),
}));
vi.mock("@/lib/appWindow", () => ({
  openAppWindowCount: fake.count,
  quitApp: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: fake.close,
    onCloseRequested: async (fn: typeof fake.onClose) => {
      fake.onClose = fn;
      return () => {};
    },
    listen: async (name: string, fn: typeof fake.onQuit) => {
      if (name === "oarlock:quit-requested") fake.onQuit = fn;
      else fake.onResume = fn as unknown as typeof fake.onResume;
      return () => {};
    },
    unminimize: async () => {},
    show: async () => {},
    setFocus: async () => {},
  }),
}));
import { useAppCloseGuard } from "./useAppCloseGuard";
import { useTabCloseGuards } from "./useTabCloseGuards";

const editor = (id: number, dirty = false): Tab => ({
  id,
  kind: "editor",
  spaceId: "s",
  path: `/file${id}`,
  title: "file",
  dirty,
  preview: false,
});
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.clearAllMocks();
  fake.close.mockReset();
  fake.count.mockReset().mockResolvedValue(2);
  fake.effects = [];
  fake.states = [];
  fake.onClose = undefined;
  fake.onQuit = undefined;
  fake.onResume = undefined;
  fake.flush.mockResolvedValue({ ok: true });
  fake.invoke.mockResolvedValue(true);
});
afterEach(async () => {
  const { releaseEditors } = await import("@/modules/editor/lib/quitBarrier");
  for (let generation = 0; generation < 10; generation++)
    releaseEditors(`window-close:${generation}`);
  for (const cleanup of fake.cleanups.splice(0)) cleanup();
  await settle();
});
it.each(["right", "other"] as const)(
  "closing %s tabs checks the live buffer before dirty badges render",
  async (kind) => {
    const dispose = vi.fn();
    const api = useTabCloseGuards({
      tabs: [editor(1), editor(2)],
      activeId: 1,
      editorIsDirty: (id) => id === 2,
      disposeTab: vi.fn(),
      disposeDeletedTabs: vi.fn(),
      disposeTabs: dispose,
    });
    if (kind === "right") api.handleCloseTabsToRight(1);
    else api.handleCloseOtherTabs(1);
    await settle();
    expect(dispose).not.toHaveBeenCalled();
    expect(fake.states[3]).toMatchObject({ dirtyIds: [2] });
  },
);
it("window closing checks the live buffer before dirty badges render", async () => {
  useAppCloseGuard({ current: [editor(1)] }, () => true);
  for (const effect of fake.effects) effect();
  await fake.onClose?.({ preventDefault: vi.fn() });
  await settle();
  expect(fake.close).not.toHaveBeenCalled();
  expect(fake.states[0]).toMatchObject({ dirtyEditors: 1 });
});
it("batch close accepts a completed save before the dirty badge clears", async () => {
  const dispose = vi.fn();
  const api = useTabCloseGuards({
    tabs: [editor(1), editor(2, true)],
    activeId: 1,
    editorIsDirty: () => false,
    disposeTab: vi.fn(),
    disposeDeletedTabs: vi.fn(),
    disposeTabs: dispose,
  });
  api.handleCloseOtherTabs(1);
  await settle();
  expect(dispose).toHaveBeenCalledOnce();
});
it("window close retains the stored dirty guard when no live editor exists", async () => {
  useAppCloseGuard({ current: [editor(1, true)] }, () => undefined);
  for (const effect of fake.effects) effect();
  await fake.onClose?.({ preventDefault: vi.fn() });
  await settle();
  expect(fake.close).not.toHaveBeenCalled();
  expect(fake.states[0]).toMatchObject({ dirtyEditors: 1 });
});
it("window close accepts a completed save before the dirty badge clears", async () => {
  useAppCloseGuard({ current: [editor(1, true)] }, () => false);
  for (const effect of fake.effects) effect();
  await fake.onClose?.({ preventDefault: vi.fn() });
  await settle();
  expect(fake.close).toHaveBeenCalledOnce();
});

function deferredFlush() {
  let release!: () => void;
  fake.flush.mockReturnValueOnce(
    new Promise((resolve) => {
      release = () => resolve({ ok: true });
    }),
  );
  return () => release();
}

it.each(["close", "quit"])(
  "%s reconfirms edits made during persistence",
  async (kind) => {
    let dirty = false;
    const api = useAppCloseGuard(
      { current: [editor(1)] },
      () => dirty,
      () => "revision",
    );
    for (const effect of fake.effects) effect();
    const release = deferredFlush();
    if (kind === "close") await fake.onClose?.({ preventDefault: vi.fn() });
    else
      await fake.onQuit?.({ payload: { round: 7, ticket: 1, verify: false } });
    await settle();
    dirty = true;
    release();
    await settle();
    expect(fake.close).not.toHaveBeenCalled();
    expect(fake.invoke).not.toHaveBeenCalledWith("app_quit_ready", {
      round: 7,
      ticket: 1,
      ok: true,
    });
    expect(fake.states[0]).toMatchObject({ dirtyEditors: 1 });
    api.confirmAppClose();
    await settle();
    if (kind === "close") expect(fake.close).toHaveBeenCalledOnce();
    else
      expect(fake.invoke).toHaveBeenCalledWith("app_quit_ready", {
        round: 7,
        ticket: 1,
        ok: true,
      });
  },
);

it.each(["before confirmation", "during persistence"])(
  "reconfirms a dirty buffer changed %s",
  async (when) => {
    let revision = "old";
    const api = useAppCloseGuard(
      { current: [editor(1)] },
      () => true,
      () => revision,
    );
    for (const effect of fake.effects) effect();
    await fake.onClose?.({ preventDefault: vi.fn() });
    const release = deferredFlush();
    if (when === "before confirmation") revision = "new";
    api.confirmAppClose();
    if (when === "during persistence") revision = "new";
    release();
    await settle();
    expect(fake.close).not.toHaveBeenCalled();
    expect(fake.states[0]).toMatchObject({ dirtyEditors: 1 });
    api.confirmAppClose();
    await settle();
    expect(fake.close).toHaveBeenCalledOnce();
  },
);

it("a completed save during persistence clears the close blocker", async () => {
  let dirty = true;
  const api = useAppCloseGuard(
    { current: [editor(1)] },
    () => dirty,
    () => "old",
  );
  for (const effect of fake.effects) effect();
  await fake.onClose?.({ preventDefault: vi.fn() });
  const release = deferredFlush();
  api.confirmAppClose();
  dirty = false;
  release();
  await settle();
  expect(fake.close).toHaveBeenCalledOnce();
});

it("Close anyway cannot bypass new edits", async () => {
  let dirty = false;
  const api = useAppCloseGuard(
    { current: [editor(1)] },
    () => dirty,
    () => "new",
  );
  for (const effect of fake.effects) effect();
  fake.flush.mockResolvedValue({ ok: false });
  await fake.onClose?.({ preventDefault: vi.fn() });
  await settle();
  dirty = true;
  const options = fake.toast.mock.calls[0][1] as {
    action: { onClick: () => void };
  };
  options.action.onClick();
  await settle();
  expect(fake.close).not.toHaveBeenCalled();
  expect(fake.states[0]).toMatchObject({ dirtyEditors: 1 });
  api.cancelAppClose();
  options.action.onClick();
  await settle();
  expect(fake.close).not.toHaveBeenCalled();
});

it("an unmounted guard cannot close after its flush resolves", async () => {
  useAppCloseGuard({ current: [editor(1)] });
  const cleanup = fake.effects.map((effect) => effect());
  const release = deferredFlush();
  await fake.onClose?.({ preventDefault: vi.fn() });
  for (const dispose of cleanup) if (typeof dispose === "function") dispose();
  release();
  await settle();
  expect(fake.close).not.toHaveBeenCalled();
});

it("dialog dismissal after confirmation does not cancel the accepted close", async () => {
  const api = useAppCloseGuard({ current: [editor(1, true)] });
  for (const effect of fake.effects) effect();
  await fake.onClose?.({ preventDefault: vi.fn() });
  const release = deferredFlush();
  api.confirmAppClose();
  api.cancelAppClose();
  release();
  await settle();
  expect(fake.close).toHaveBeenCalledOnce();
});

it("a delayed preference save cannot confirm a replacement prompt", async () => {
  const api = useAppCloseGuard({ current: [editor(1, true)] });
  for (const effect of fake.effects) effect();
  await fake.onClose?.({ preventDefault: vi.fn() });
  const original = fake.states[0] as NonNullable<typeof api.pendingAppClose>;
  api.cancelAppClose();
  await fake.onClose?.({ preventDefault: vi.fn() });
  api.confirmAppClose(original);
  await settle();
  expect(fake.close).not.toHaveBeenCalled();
  expect(fake.flush).not.toHaveBeenCalled();
  api.confirmAppClose();
  await settle();
  expect(fake.close).toHaveBeenCalledOnce();
});

it("editing after approval invalidates the native ticket and final verification refuses it", async () => {
  let revision = "first";
  const api = useAppCloseGuard(
    { current: [editor(1)] },
    () => true,
    () => revision,
  );
  for (const effect of fake.effects) effect();
  await fake.onQuit?.({ payload: { round: 10, ticket: 1, verify: false } });
  api.confirmAppClose();
  await settle();
  expect(fake.invoke).toHaveBeenCalledWith("app_quit_ready", {
    round: 10,
    ticket: 1,
    ok: true,
  });
  revision = "second";
  const { documentRevisionChanged } = await import(
    "@/modules/editor/lib/quitBarrier"
  );
  documentRevisionChanged();
  expect(fake.invoke).toHaveBeenCalledWith("app_quit_changed", {
    round: 10,
    ticket: 1,
  });
  await fake.onQuit?.({ payload: { round: 10, ticket: 3, verify: true } });
  expect(fake.invoke).toHaveBeenCalledWith("app_quit_ready", {
    round: 10,
    ticket: 3,
    ok: false,
  });
});
it("a new quit round waits for an aborted flush and then makes progress", async () => {
  useAppCloseGuard({ current: [editor(1)] }, () => false);
  for (const effect of fake.effects) effect();
  const release = deferredFlush();
  await fake.onQuit?.({ payload: { round: 10, ticket: 1, verify: false } });
  fake.onResume?.({ payload: { round: 10, ticket: null } });
  await fake.onQuit?.({ payload: { round: 11, ticket: 1, verify: false } });
  release();
  await settle();
  expect(fake.invoke).not.toHaveBeenCalledWith("app_quit_ready", {
    round: 10,
    ticket: 1,
    ok: true,
  });
  expect(fake.invoke).toHaveBeenCalledWith("app_quit_ready", {
    round: 11,
    ticket: 1,
    ok: true,
  });
});

it("a native close failure releases the final input barrier", async () => {
  const { editorQuitSealed } = await import("@/modules/editor/lib/quitBarrier");
  fake.close.mockRejectedValueOnce(new Error("native refused"));
  useAppCloseGuard({ current: [editor(1)] }, () => false);
  for (const effect of fake.effects) effect();
  await fake.onClose?.({ preventDefault: vi.fn() });
  await settle();
  expect(editorQuitSealed()).toBe(false);
  expect(fake.toast).toHaveBeenCalledWith(
    "Could not close the window",
    expect.anything(),
  );
});

it("a local close finishing its flush cannot replace a final quit seal", async () => {
  useAppCloseGuard({ current: [editor(1)] }, () => false);
  for (const effect of fake.effects) effect();
  await fake.onQuit?.({ payload: { round: 50, ticket: 1, verify: false } });
  await settle();
  const finishCloseFlush = deferredFlush();
  await fake.onClose?.({ preventDefault: vi.fn() });
  const finishQuitFlush = deferredFlush();
  await fake.onQuit?.({ payload: { round: 50, ticket: 3, verify: true } });
  fake.close.mockRejectedValueOnce(new Error("close refused"));
  finishCloseFlush();
  await settle();
  const { editorQuitSealed } = await import("@/modules/editor/lib/quitBarrier");
  try {
    expect(fake.close).not.toHaveBeenCalled();
    expect(editorQuitSealed()).toBe(true);
  } finally {
    finishQuitFlush();
    await settle();
  }
});
it("a disposed close listener cannot prevent a later native close", async () => {
  useAppCloseGuard({ current: [editor(1)] });
  for (const effect of fake.effects) effect();
  const stale = fake.onClose;
  for (const cleanup of fake.cleanups.splice(0)) cleanup();
  const preventDefault = vi.fn();
  await stale?.({ preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
});

it("a delayed earlier close check cannot reopen a cancelled prompt", async () => {
  const api = useAppCloseGuard({ current: [editor(1, true)] });
  for (const effect of fake.effects) effect();
  let finishCount!: (count: number) => void;
  fake.count.mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        finishCount = resolve;
      }),
  );
  const earlier = fake.onClose?.({ preventDefault: vi.fn() });
  await settle();
  await fake.onClose?.({ preventDefault: vi.fn() });
  expect(fake.states[0]).toMatchObject({ dirtyEditors: 1 });
  api.cancelAppClose();
  finishCount(2);
  await earlier;
  expect(fake.states[0]).toBeNull();
  expect(fake.close).not.toHaveBeenCalled();
});
it("a delayed local close check cannot replace a newer native quit prompt", async () => {
  const api = useAppCloseGuard({ current: [editor(1, true)] });
  for (const effect of fake.effects) effect();
  let finishCount!: (count: number) => void;
  fake.count.mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        finishCount = resolve;
      }),
  );
  const earlier = fake.onClose?.({ preventDefault: vi.fn() });
  await settle();
  await fake.onQuit?.({ payload: { round: 60, ticket: 1, verify: false } });
  finishCount(2);
  await earlier;
  expect(fake.states[0]).toMatchObject({ quitRound: 60 });
  api.cancelAppClose();
  expect(fake.invoke).toHaveBeenCalledWith("app_quit_cancel", { round: 60 });
});
