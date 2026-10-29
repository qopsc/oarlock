import { afterEach, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { editorQuitExtension } from "./quitExtension";
import {
  sealEditors,
  releaseEditors,
  deferEditorLifecycle,
} from "./quitBarrier";
afterEach(() => releaseEditors("test"));
it("the final check blocks editor transactions until native releases the seal", () => {
  let state = EditorState.create({
    doc: "draft",
    extensions: [editorQuitExtension],
  });
  state = state.update({ changes: { from: 5, insert: " before" } }).state;
  sealEditors("test");
  state = state.update({ changes: { from: 0, insert: "rejected" } }).state;
  expect(state.doc.toString()).toBe("draft before");
  releaseEditors("test");
  state = state.update({ changes: { from: 0, insert: "after " } }).state;
  expect(state.doc.toString()).toBe("after draft before");
});
it("deferred lifecycle work is bounded per session and only resumes for the matching seal", () => {
  sealEditors("test");
  const owner = {};
  let last = 0;
  for (let i = 0; i < 100; i++)
    deferEditorLifecycle(owner, "reload", () => {
      last = i;
    });
  releaseEditors("older");
  expect(last).toBe(0);
  releaseEditors("test");
  expect(last).toBe(99);
});
