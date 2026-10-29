import { EditorView, runScopeHandlers } from "@codemirror/view";

export type ShellInputGateOwner = {
  defer: (action: () => void, size?: number) => boolean;
  holding: () => boolean;
  reserve: () => ((action: () => void, size?: number) => void) | null;
  noteInput: () => void;
};

/** Routes command-bar edits through the terminal's existing input queue. */
export function shellInputGate(owner: ShellInputGateOwner) {
  let composition: ((action: () => void, size?: number) => void) | null = null;
  const extensions = [
    EditorView.domEventHandlers({
      keydown(event, view) {
        owner.noteInput();
        const key = event.key.toLowerCase();
        if (event.isComposing || event.keyCode === 229 ||
            (event.metaKey && key !== "z" && key !== "a") ||
            (event.key.length === 1 && !event.metaKey &&
             (!event.ctrlKey || event.altKey))) return false;
        return owner.defer(() => { runScopeHandlers(view, event, "editor"); }, event.key.length * 2);
      },
      compositionstart() {
        if (owner.holding()) composition = owner.reserve();
        return false;
      },
      compositionend(event, view) {
        if (!composition) return false;
        const finish = composition;
        composition = null;
        const text = event.data;
        owner.noteInput();
        finish(() => {
          if (text) view.dispatch(view.state.replaceSelection(text));
        }, text.length * 2);
        return false;
      },
    }),
    EditorView.inputHandler.of((view, from, to, text) => {
      owner.noteInput();
      if (composition) return true;
      const selection = view.state.selection.main;
      const selected = from === selection.from && to === selection.to;
      const startOffset = from - selection.head;
      const endOffset = to - selection.head;
      return owner.defer(() => {
        if (selected) {
          view.dispatch(view.state.replaceSelection(text));
        } else {
          const head = view.state.selection.main.head;
          const length = view.state.doc.length;
          const start = Math.max(0, Math.min(length, head + startOffset));
          const end = Math.max(start, Math.min(length, head + endOffset));
          view.dispatch({ changes: { from: start, to: end, insert: text },
            selection: { anchor: start + text.length }, userEvent: "input" });
        }
      }, text.length * 2);
    }),
  ];
  return {
    extensions,
    cancel: () => {
      const finish = composition;
      composition = null;
      finish?.(() => {});
    },
  };
}
