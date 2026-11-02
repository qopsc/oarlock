import { EditorState } from "@codemirror/state";
import { expect, it, vi } from "vitest";
import { loadGitBaseline } from "./gitBaseline";
import { gitChangeGutter, markedLines } from "./gitGutter";

it("loads the baseline after the editor view appears and marks changed lines", async () => {
  const read = vi.fn().mockResolvedValue("old\n");
  const stopMissing = loadGitBaseline(null, read);
  expect(read).not.toHaveBeenCalled();
  stopMissing();
  let state = EditorState.create({ doc: "new\n", extensions: gitChangeGutter });
  const view = { dispatch: (transaction: Parameters<typeof state.update>[0]) => { state = state.update(transaction).state; } };
  const stop = loadGitBaseline(view, read);
  await Promise.resolve();
  expect(markedLines(state)).toContain(1);
  stop();
});

it("does not apply a superseded baseline to a closed view", async () => {
  let resolve!: (value: string) => void;
  const dispatch = vi.fn();
  const stop = loadGitBaseline({ dispatch }, () => new Promise((done) => { resolve = done; }));
  stop();
  resolve("old");
  await Promise.resolve();
  expect(dispatch).not.toHaveBeenCalled();
});
