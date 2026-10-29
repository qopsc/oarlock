import { history } from "@codemirror/commands";
import { type Compartment, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** A terminal change must not leave the previous terminal's undo history. */
export function replaceShellDraft(
  view: EditorView,
  historyCompartment: Compartment,
  text: string,
): void {
  view.dispatch({ effects: historyCompartment.reconfigure([]) });
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length },
    effects: historyCompartment.reconfigure(history()),
    annotations: Transaction.addToHistory.of(false),
  });
}
