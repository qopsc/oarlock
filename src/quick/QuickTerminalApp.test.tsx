import { describe, expect, it, vi } from "vitest";
const session = vi.hoisted(() => ({
  dispose: vi.fn(), hide: vi.fn(), leaf: 1 as number | null,
  last: { current: 1 }, restart: { current: false },
  focus: undefined as undefined | ((event: { payload: boolean }) => void),
  effectIndex: 0,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => initial === 1
    ? [session.leaf, (next: number | null) => { session.leaf = next; }]
    : [initial, vi.fn()],
  useEffect: (effect: () => void) => {
    if (session.effectIndex++ === 1) effect();
  },
  useCallback: (callback: unknown) => callback,
  useRef: (value: unknown) => value === 1 ? session.last : value === false ? session.restart : { current: value },
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (select: (state: unknown) => unknown) =>
    select({ hydrated: true, terminalBehavior: { quickTerminalAutohide: true } }),
}));
vi.mock("@/modules/terminal", () => ({ disposeSession: session.dispose, TerminalPromptDialog: () => null }));
vi.mock("@/modules/terminal/TerminalPane", () => ({ TerminalPane: () => null }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide: session.hide,
    onFocusChanged: (handler: typeof session.focus) => { session.focus = handler; return Promise.resolve(vi.fn()); },
  }),
}));
import { QuickTerminalApp } from "./QuickTerminalApp";

describe("quick terminal lifecycle", () => {
  it("waits until the window is shown again before starting a replacement shell", () => {
    for (let leaf = 1; leaf <= 3; leaf++) {
      const pane = QuickTerminalApp().props.children[0].props.children;
      expect(pane.props.leafId).toBe(leaf);
      pane.props.onExit();
      expect(session.dispose).toHaveBeenLastCalledWith(leaf);
      expect(session.leaf).toBeNull();
      expect(QuickTerminalApp().props.children[0].props.children).toBeNull();
      session.focus?.({ payload: false });
      expect(session.leaf).toBeNull();
      session.focus?.({ payload: true });
      expect(session.leaf).toBe(leaf + 1);
    }
    expect(session.dispose).toHaveBeenCalledTimes(3);
  });
});
