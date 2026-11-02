import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";

export type VimHandlers = {
  save: () => Promise<boolean>;
  identity: () => unknown;
  canClose: () => boolean;
  close: () => void;
  filetype?: { get: () => string; set: (value: string) => void };
};

const handlers = new WeakMap<EditorView, { current: VimHandlers }>();

/** A CodeMirror extension that binds :w / :q handlers to this view. */
export function vimHandlersExtension(
  getHandlers: () => VimHandlers,
): Extension {
  return ViewPlugin.define((view) => {
    const registration = { current: getHandlers() };
    handlers.set(view, registration);
    let identity = registration.current.identity();
    const bindFiletype = () => {
      const cm = getCM(view);
      if (cm) cm.vimFiletype = registration.current.filetype;
    };
    bindFiletype();
    const cancel = () => {
      const cm = getCM(view);
      if (cm) Vim.cancelPending(cm);
    };
    return {
      update() {
        // Keep handlers fresh in case the closure captured stale refs.
        registration.current = getHandlers();
        bindFiletype();
        const nextIdentity = registration.current.identity();
        if (identity !== nextIdentity) {
          identity = nextIdentity;
          cancel();
        }
      },
      destroy() {
        cancel();
        const cm = getCM(view);
        if (cm) cm.vimFiletype = undefined;
        handlers.delete(view);
      },
    };
  });
}

let initialized = false;

export function initVimGlobals(): void {
  if (initialized) return;
  initialized = true;

  type CmAdapter = { cm6?: EditorView };
  const getView = (cm: CmAdapter) => cm.cm6;

  Vim.defineEx("write", "w", (cm: CmAdapter) => {
    const view = getView(cm);
    if (view) return handlers.get(view)?.current.save();
  });

  Vim.defineEx("quit", "q", (cm: CmAdapter) => {
    const view = getView(cm);
    if (view) handlers.get(view)?.current.close();
  });

  const writeAndQuit = (cm: CmAdapter) => {
    const view = getView(cm);
    if (!view) return;
    const h = handlers.get(view);
    if (!h) return;
    const identity = h.current.identity();
    return h.current.save().then(
      (saved) => {
        if (
          saved &&
          handlers.get(view) === h &&
          h.current.identity() === identity &&
          h.current.canClose()
        )
          h.current.close();
      },
      () => {
        /* Save failures are reported by the editor; keep the tab. */
      },
    );
  };
  Vim.defineEx("wq", "wq", writeAndQuit);
  Vim.defineEx("xit", "x", writeAndQuit);

  // Arrow keys are forwarded by the plugin to the editor scope handlers,
  // which breaks operator-pending (d<Up>) and counts (15<Up>). Remap to
  // hjkl so they stay inside the vim state machine.
  Vim.map("<Up>", "k", "normal");
  Vim.map("<Down>", "j", "normal");
  Vim.map("<Left>", "h", "normal");
  Vim.map("<Right>", "l", "normal");
  Vim.map("<Up>", "k", "visual");
  Vim.map("<Down>", "j", "visual");
  Vim.map("<Left>", "h", "visual");
  Vim.map("<Right>", "l", "visual");
}
