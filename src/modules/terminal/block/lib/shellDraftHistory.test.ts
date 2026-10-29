import { history, redo, undo, undoDepth } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { expect, it } from "vitest";
import { replaceShellDraft } from "./shellDraftHistory";

it("cannot undo a terminal switch into another terminal's draft", () => {
  const compartment = new Compartment();
  let state = EditorState.create({ doc: "", extensions: [compartment.of(history())] });
  const view = {
    get state() { return state; },
    dispatch: (transaction: Parameters<EditorState["update"]>[0]) => {
      state = state.update(transaction).state;
    },
  } as unknown as EditorView;
  view.dispatch({ changes: { from: 0, insert: "first terminal secret" } });
  expect(undoDepth(state)).toBeGreaterThan(0);
  replaceShellDraft(view, compartment, "second terminal draft");
  expect(undoDepth(state)).toBe(0);
  expect(undo(view)).toBe(false);
  expect(redo(view)).toBe(false);
  expect(state.doc.toString()).toBe("second terminal draft");
  view.dispatch({ changes: { from: state.doc.length, insert: "!" } });
  expect(undo(view)).toBe(true);
  expect(state.doc.toString()).toBe("second terminal draft");
});
