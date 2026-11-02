import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { CodeMirror } from "./upstream/index.js";
import { evaluate } from "./regex-worker.js";
describe("Vim worker preserves upstream cursor semantics", () => {
  const docs = [
    "aaa foo aaa\nfoo end",
    "a\nb\na\nb",
    "é😀 é\n\nend",
    "abc xyz abc",
  ];
  const patterns = [
    /a/,
    /aa/,
    /foo/,
    /^/m,
    /$/m,
    /\b/m,
    /(?=a)/,
    /a(?=a)/,
    /(a)\1/,
    /a\nb/m,
    /é|😀/,
    /abc|xyz/i,
  ];
  for (const text of docs)
    for (const query of patterns)
      for (const back of [false, true])
        it(`${query} ${back ? "back" : "forward"} ${JSON.stringify(text)}`, () => {
          const state = EditorState.create({ doc: text });
          for (let from = 0; from <= text.length; from++) {
            const line = state.doc.lineAt(from);
            const cm = { cm6: { state } };
            const original = CodeMirror.prototype.getSearchCursor.call(
              cm,
              query,
              { line: line.number - 1, ch: from - line.from },
            );
            const found = original.find(back);
            const result = evaluate({
              text,
              kind: "cursor",
              source: query.source,
              flags: query.flags,
              from,
              back,
            });
            if (!found) expect(result).toBeNull();
            else {
              const start = original.from(),
                end = original.to();
              expect(result.from).toBe(
                state.doc.line(start.line + 1).from + start.ch,
              );
              expect(result.to).toBe(
                state.doc.line(end.line + 1).from + end.ch,
              );
              expect(result.match).toEqual(original.match);
            }
          }
        });
  it("tracks sequential document changes without recopying the document", () => {
    evaluate({
      text: "one two",
      kind: "cursor",
      source: "two",
      flags: "",
      from: 0,
    });
    const result = evaluate({
      changes: [[{ from: 0, to: 3, insert: "three" }]],
      kind: "cursor",
      source: "two",
      flags: "",
      from: 0,
    });
    expect(result.from).toBe(6);
    expect(result.to).toBe(9);
  });
  it("rejects oversized patterns and documents", () => {
    expect(() =>
      evaluate({
        text: "",
        source: "a".repeat(4097),
        flags: "",
        kind: "cursor",
        from: 0,
      }),
    ).toThrow("4,096");
    expect(() =>
      evaluate({
        text: "a".repeat(8_388_609),
        source: "x",
        flags: "",
        kind: "cursor",
        from: 0,
      }),
    ).toThrow("16 MiB");
  });
});
