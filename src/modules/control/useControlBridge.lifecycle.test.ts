import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  cleanup: undefined as undefined | (() => void),
  receive: undefined as undefined | ((event: { payload: unknown }) => void),
  invoke: vi.fn(async () => true),
  show: vi.fn(async () => {}),
  focus: vi.fn(async () => {}),
}));
vi.mock("react", () => ({
  useEffect: (fn: () => () => void) => {
    fake.cleanup = fn();
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, receive: typeof fake.receive) => {
    fake.receive = receive;
    return () => {};
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: fake.show, setFocus: fake.focus }),
}));
vi.mock("./lib/context", () => ({
  resolveControlContext: () => ({ space_id: "original" }),
}));
vi.mock("@/modules/tabs/lib/useTabs", () => ({ DEFAULT_SPACE_ID: "default" }));
import { useControlBridge } from "./useControlBridge";
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const open = vi.fn(() => 7);
function request(focus: boolean) {
  fake.receive?.({
    payload: {
      id: "request-1",
      method: "open",
      caller: {},
      params: { path: "/repo/file", focus },
    },
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  fake.show.mockResolvedValue();
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  useControlBridge({
    ready: true,
    tabsRef: { current: [] },
    activeTabIdRef: { current: 0 },
    activeSpaceIdRef: { current: "original" },
    onOpen: open,
  });
  await flush();
});
afterEach(() => {
  fake.cleanup?.();
  vi.unstubAllGlobals();
});
it("acknowledges no-focus open without waiting for a visible animation frame", async () => {
  request(false);
  await flush();
  expect(open).toHaveBeenCalledOnce();
  expect(fake.invoke).toHaveBeenCalledWith(
    "control_respond",
    expect.objectContaining({
      response: expect.objectContaining({ ok: true }),
    }),
  );
  expect(requestAnimationFrame).not.toHaveBeenCalled();
});
it("does not open after the bridge closes during window focus", async () => {
  let done: () => void = () => {};
  fake.show.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  request(true);
  fake.cleanup?.();
  done();
  await flush();
  expect(open).not.toHaveBeenCalled();
  expect(fake.focus).not.toHaveBeenCalled();
  expect(fake.invoke).toHaveBeenCalledWith(
    "control_respond",
    expect.objectContaining({
      response: expect.objectContaining({ ok: false }),
    }),
  );
});
it("refuses an event already queued when the bridge closes", async () => {
  fake.cleanup?.();
  request(false);
  await flush();
  expect(open).not.toHaveBeenCalled();
});
