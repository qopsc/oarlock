import type { WorkspaceEnv } from "@/modules/workspace/env";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  workspace: { kind: "local" } as WorkspaceEnv,
  cleanup: undefined as (() => void) | undefined,
  callbacks: [] as ((event: unknown) => void)[],
  settle: [] as ((cleanup: () => void) => void)[],
  paste: vi.fn(() => true),
  invoke: vi.fn(),
  authorize: vi.fn(async () => {}),
}));
vi.mock("react", async (original) => ({
  ...(await original<object>()),
  useEffect: (effect: () => () => void) => {
    state.cleanup = effect();
  },
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, () => {}],
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (callback: (event: unknown) => void) => {
      state.callbacks.push(callback);
      return new Promise<() => void>((resolve) => state.settle.push(resolve));
    },
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: state.invoke }));
vi.mock("@/lib/platform", () => ({ IS_WINDOWS: false }));
vi.mock("@/lib/nativeDropPoint", () => ({
  nativeDropPoint: (p: unknown) => p,
}));
vi.mock("./terminalSessionApi", () => ({
  dropPathsIntoSession: state.paste,
  dropOnSession: () => false,
  offerDragToSession: () => false,
  leaveSessionDrag: () => {},
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => state.workspace,
}));
vi.mock("@/modules/mac-privacy", () => ({ showFileError: vi.fn() }));
vi.mock("@/modules/explorer/lib/clipboardPaste", () => ({
  authorizeSources: state.authorize,
  parentDir: () => "/repo",
  reportCopyFailures: () => {},
}));
import { useTerminalFileDrop } from "./useTerminalFileDrop";
import { useExplorerFileDrop } from "@/modules/explorer/lib/useExplorerFileDrop";
const drop = {
  payload: { type: "drop", paths: ["/tmp/file"], position: { x: 1, y: 1 } },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  state.invoke.mockReset();
  state.authorize.mockReset().mockResolvedValue(undefined);
  state.workspace = { kind: "local" };
  state.callbacks = [];
  state.settle = [];
});
it("ignores terminal drops after disposal while listener registration is still pending", async () => {
  vi.stubGlobal("document", {
    elementFromPoint: () => ({
      closest: () => ({ dataset: { paneLeaf: "7" } }),
    }),
  });
  useTerminalFileDrop();
  state.cleanup?.();
  useTerminalFileDrop();
  state.callbacks[0](drop);
  state.callbacks[1](drop);
  expect(state.paste).toHaveBeenCalledTimes(1);
  const oldUnlisten = vi.fn();
  state.settle[0](oldUnlisten);
  await Promise.resolve();
  expect(oldUnlisten).toHaveBeenCalledOnce();
  state.cleanup?.();
  state.settle[1](() => {});
});
it("does not copy files through a retired Explorer drop listener", async () => {
  vi.stubGlobal("document", {
    elementFromPoint: () => ({
      closest: () => ({ getAttribute: () => "/repo" }),
    }),
  });
  useExplorerFileDrop({
    rootPath: "/repo",
    isDir: () => true,
    onCopied: vi.fn(),
  });
  state.cleanup?.();
  state.callbacks[0](drop);
  await Promise.resolve();
  expect(state.authorize).not.toHaveBeenCalled();
  expect(state.invoke).not.toHaveBeenCalled();
  state.settle[0](() => {});
});

it("does not start a copy after its Explorer closes during source authorization", async () => {
  vi.stubGlobal("document", {
    elementFromPoint: () => ({
      closest: () => ({ getAttribute: () => "/repo" }),
    }),
  });
  let finish!: () => void;
  state.authorize.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  state.invoke.mockResolvedValueOnce({ created: [], failed: [] });
  useExplorerFileDrop({
    rootPath: "/repo",
    isDir: () => true,
    onCopied: vi.fn(),
  });
  state.callbacks[0](drop);
  state.cleanup?.();
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(state.invoke).not.toHaveBeenCalled();
  state.settle[0](() => {});
});

it("starts the authorized drop while its Explorer is still current", async () => {
  vi.stubGlobal("document", {
    elementFromPoint: () => ({
      closest: () => ({ getAttribute: () => "/repo" }),
    }),
  });
  state.invoke.mockResolvedValueOnce({ created: ["/repo/file"], failed: [] });
  const onCopied = vi.fn();
  useExplorerFileDrop({ rootPath: "/repo", isDir: () => true, onCopied });
  state.callbacks[0](drop);
  await vi.waitFor(() => expect(onCopied).toHaveBeenCalledWith("/repo"));
  expect(state.invoke).toHaveBeenCalledWith(
    "fs_copy",
    expect.objectContaining({ destDir: "/repo", workspace: state.workspace }),
  );
  state.cleanup?.();
  state.settle[0](() => {});
});

it("does not dispatch a drop into the old environment after authorization resolves", async () => {
  vi.stubGlobal("document", {
    elementFromPoint: () => ({
      closest: () => ({ getAttribute: () => "/repo" }),
    }),
  });
  let finish!: () => void;
  state.authorize.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  useExplorerFileDrop({
    rootPath: "/repo",
    isDir: () => true,
    onCopied: vi.fn(),
  });
  state.callbacks[0](drop);
  state.workspace = { kind: "wsl", distro: "Ubuntu" };
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(state.invoke).not.toHaveBeenCalled();
  state.cleanup?.();
  state.settle[0](() => {});
});
