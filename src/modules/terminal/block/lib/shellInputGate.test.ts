import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import { BoundedPtyWriter } from "@/modules/terminal/lib/BoundedPtyWriter";
import type { PtySession } from "@/modules/terminal/lib/pty-bridge";
import { shellInputGate } from "./shellInputGate";

function setup() {
  const writer = new BoundedPtyWriter((error) => { throw error; });
  writer.attach({ id: 1, write: async () => {}, close: async () => {}, resize: async () => {} } as PtySession);
  const submitted: string[] = [];
  const owner = { defer: (action: () => void, size?: number) => writer.deferInput(action, size),
    reserve: () => writer.reserveInput(), holding: () => writer.holdingInput, noteInput: vi.fn() };
  const gate = shellInputGate(owner);
  const extensions = gate.extensions;
  let state = EditorState.create({ extensions: [extensions, keymap.of([{
    key: "Enter", run: (view) => { submitted.push(view.state.doc.toString()); return true; },
  }])] });
  const view = { get state() { return state; }, dispatch: (spec: Parameters<EditorState["update"]>[0]) => {
    state = state.update(spec).state;
  } } as unknown as EditorView;
  const handlers = extensions[0] as unknown as { domEventHandlers: {
    keydown: (event: KeyboardEvent, view: EditorView) => boolean;
    compositionstart: () => boolean;
    compositionend: (event: CompositionEvent, view: EditorView) => boolean;
  } };
  return { writer, view, submitted, gate, handlers: handlers.domEventHandlers,
    input: state.facet(EditorView.inputHandler)[0] };
}
const enter = () => Object.assign(new Event("keydown", { cancelable: true }), {
  key: "Enter", code: "Enter", keyCode: 13, isComposing: false, ctrlKey: false,
  altKey: false, metaKey: false, shiftKey: false,
}) as KeyboardEvent;

it("orders direct command-bar text and Enter after the pending paste", () => {
  const { writer, view, submitted, handlers, input } = setup();
  const finish = writer.reserveInput();
  if (!finish) throw new Error("Could not reserve input");
  expect(input(view, 0, 0, "typed", () => { throw Error("not used"); })).toBe(true);
  expect(handlers.keydown(enter(), view)).toBe(true);
  expect(submitted).toEqual([]);
  finish(() => view.dispatch(view.state.replaceSelection("paste ")));
  expect(submitted).toEqual(["paste typed"]);
  writer.dispose();
});

it("queues the final composition as one edit behind a pending paste", () => {
  const { writer, view, handlers, input } = setup();
  const finish = writer.reserveInput();
  if (!finish) throw new Error("Could not reserve input");
  handlers.compositionstart();
  expect(input(view, 0, 0, "n", () => { throw Error("not used"); })).toBe(true);
  expect(input(view, 0, 0, "ni", () => { throw Error("not used"); })).toBe(true);
  handlers.compositionend({ data: "你" } as CompositionEvent, view);
  finish(() => view.dispatch(view.state.replaceSelection("paste ")));
  expect(view.state.doc.toString()).toBe("paste 你");
  writer.dispose();
});

it("releases a pending composition when the command editor retargets", async () => {
  const { writer, gate, handlers } = setup();
  const first = writer.reserveInput();
  if (!first) throw new Error("Could not reserve input");
  handlers.compositionstart();
  expect(writer.hasPendingInput).toBe(true);
  gate.cancel();
  first(() => {});
  await vi.waitFor(() => expect(writer.hasPendingInput).toBe(false));
  writer.dispose();
});
