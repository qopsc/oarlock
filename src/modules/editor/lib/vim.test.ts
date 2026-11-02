import type { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  commands: new Map<string, (cm: { cm6: EditorView }) => void>(),
}));
vi.mock("@codemirror/view", () => ({
  ViewPlugin: { define: (create: unknown) => ({ create }) },
}));
vi.mock("@replit/codemirror-vim", () => ({
  getCM: (view: unknown) => view,
  Vim: {
    cancelPending: mocks.cancel,
    defineEx: (
      name: string,
      _alias: string,
      command: (cm: { cm6: EditorView }) => void,
    ) => {
      mocks.commands.set(name, command);
    },
    map: () => {},
  },
}));
import { initVimGlobals, vimHandlersExtension, type VimHandlers } from "./vim";
initVimGlobals();
function register(
  handlers: Omit<VimHandlers, "identity"> &
    Partial<Pick<VimHandlers, "identity">>,
) {
  const view = {} as EditorView;
  const extension = vimHandlersExtension(() => ({
    identity: () => 0,
    ...handlers,
  })) as unknown as {
    create: (view: EditorView) => { destroy: () => void; update: () => void };
  };
  const plugin = extension.create(view);
  return { cm: { cm6: view }, plugin };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
it.each(["wq", "xit"])(
  "%s waits for successful saving before closing",
  async (name) => {
    let complete!: (saved: boolean) => void;
    const close = vi.fn();
    const saving = new Promise<boolean>((resolve) => {
      complete = resolve;
    });
    const { cm, plugin } = register({
      save: () => saving,
      canClose: () => true,
      close,
    });
    mocks.commands.get(name)?.(cm);
    expect(close).not.toHaveBeenCalled();
    plugin.update();
    complete(true);
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    plugin.destroy();
  },
);

it.each(["failed", "rejected", "typing", "destroyed", "retargeted"])(
  "keeps the tab after %s",
  async (reason) => {
    let complete!: (saved: boolean) => void;
    let reject!: (error: Error) => void;
    const close = vi.fn();
    let clean = true;
    let identity = 0;
    const saving = new Promise<boolean>((resolve, fail) => {
      complete = resolve;
      reject = fail;
    });
    const { cm, plugin } = register({
      save: () => saving,
      canClose: () => clean,
      identity: () => identity,
      close,
    });
    mocks.commands.get("wq")?.(cm);
    if (reason === "typing") clean = false;
    if (reason === "retargeted") identity++;
    if (reason === "destroyed") plugin.destroy();
    if (reason === "rejected") reject(new Error("write failed"));
    else complete(reason !== "failed");
    await flush();
    expect(close).not.toHaveBeenCalled();
    plugin.destroy();
  },
);
it("quit alone keeps using the ordinary unsaved-changes close guard", () => {
  const close = vi.fn();
  const save = vi.fn(async () => false);
  const { cm, plugin } = register({ save, canClose: () => false, close });
  mocks.commands.get("quit")?.(cm);
  expect(close).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
  plugin.destroy();
});

it("cancels suspended Vim commands when the document identity changes", () => {
  let identity = 0;
  const { plugin } = register({
    identity: () => identity,
    save: async () => true,
    canClose: () => true,
    close: () => {},
  });
  mocks.cancel.mockClear();
  plugin.update();
  expect(mocks.cancel).not.toHaveBeenCalled();
  identity++;
  plugin.update();
  expect(mocks.cancel).toHaveBeenCalledOnce();
  plugin.destroy();
  expect(mocks.cancel).toHaveBeenCalledTimes(2);
});
