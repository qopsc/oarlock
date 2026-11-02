import { focusClaimsChord } from "@/modules/shortcuts/lib/shortcutScope";
import { gotoLine, searchKeymap } from "@codemirror/search";
import { EditorState, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { editorClaimedModKey, editorKeymap } from "./editorKeymap";
import { safeSearchKeymap } from "../search/regexView";

/**
 * The command the editor runs for a key off macOS (where `Mod` is Ctrl): the
 * first editor-scoped binding in precedence order, as CodeMirror resolves it.
 */
function commandFor(state: EditorState, key: string) {
  const names = new Set([key, key.replace(/^Ctrl-/, "Mod-")]);
  for (const bindings of state.facet(keymap)) {
    for (const b of bindings) {
      const scoped = !b.scope || b.scope.split(" ").includes("editor");
      if (b.key && names.has(b.key) && scoped && b.run) return b.run;
    }
  }
  return undefined;
}

describe("editorKeymap", () => {
  // basicSetup adds the search keymap before the pane's own extensions.
  const state = EditorState.create({
    extensions: [keymap.of(searchKeymap), editorKeymap(vi.fn())],
  });

  it("goes to a line on Ctrl+G ahead of the search keymap's find-next", () => {
    expect(commandFor(state, "Ctrl-g")).toBe(gotoLine);
  });

  it("goes to a line ahead of the safe search keymap, while Vim retains priority", () => {
    const editor = editorKeymap(vi.fn());
    const normal = EditorState.create({ extensions: [editor, safeSearchKeymap] });
    expect(commandFor(normal, "Ctrl-g")).toBe(gotoLine);

    const vimCommand = () => true;
    const vim = Prec.highest(keymap.of([{ key: "Ctrl-g", run: vimCommand }]));
    const withVim = EditorState.create({ extensions: [vim, editor, safeSearchKeymap] });
    expect(commandFor(withVim, "Ctrl-g")).toBe(vimCommand);
  });

  it("saves on Mod+S", () => {
    const save = vi.fn();
    const own = EditorState.create({ extensions: editorKeymap(save) });
    commandFor(own, "Mod-s")?.({} as never);
    expect(save).toHaveBeenCalledOnce();
  });
});

describe("editorClaimedModKey", () => {
  const ctrlG = {
    key: "g",
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
  };

  it("keeps Ctrl+G from Source Control off macOS only", () => {
    expect(focusClaimsChord(ctrlG, editorClaimedModKey(false), false)).toBe(
      true,
    );
    expect(
      focusClaimsChord(
        { ...ctrlG, shiftKey: true },
        editorClaimedModKey(false),
        false,
      ),
    ).toBe(false);
    expect(
      focusClaimsChord(
        { ...ctrlG, ctrlKey: false, metaKey: true },
        editorClaimedModKey(true),
        true,
      ),
    ).toBe(false);
  });
});
