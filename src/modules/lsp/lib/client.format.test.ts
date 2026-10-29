import { EditorState, StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";

vi.mock("./safeMarkdown", () => ({ installSafeMarkdown: () => {} }));

import { formatDocumentAndWait } from "./client";

it.each(["language", "document", "owner", "readOnly", "unchanged"])(
  "validates %s before applying formatting",
  async (reason) => {
    let complete: (edits: unknown) => void = () => {};
    const plugin = {
      documentUri: "file:///repo/code.txt",
      client: {
        ready: true,
        capabilities: { documentFormattingProvider: true },
        textDocumentFormatting: () =>
          new Promise((r) => {
            complete = r;
          }),
      },
    };
    let active: unknown = plugin,
      current = true;
    const view = {
      state: EditorState.create({ doc: "before" }),
      plugin: () => active,
      dispatch: vi.fn(),
    };
    const pending = formatDocumentAndWait(
      view as unknown as EditorView,
      () => current,
    );
    if (reason === "language") active = { ...plugin };
    if (reason === "document")
      view.state = EditorState.create({ doc: "newer" });
    if (reason === "owner") current = false;
    if (reason === "readOnly")
      view.state = view.state.update({
        effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)),
      }).state;
    complete([
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 6 },
        },
        newText: "formatted",
      },
    ]);
    await pending;
    expect(view.dispatch).toHaveBeenCalledTimes(reason === "unchanged" ? 1 : 0);
  },
);
