import { EditorState } from "@codemirror/state";
import { editorQuitSealed } from "./quitBarrier";

// An extender/filter cannot protect filter:false programmatic transactions.
// changeFilter covers ordinary editor input; DocumentSession also rejects new
// content while sealed, and async formatting checks the barrier before adoption.
export const editorQuitExtension = EditorState.changeFilter.of(
  () => !editorQuitSealed(),
);
