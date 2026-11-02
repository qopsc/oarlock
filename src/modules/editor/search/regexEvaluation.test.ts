import { expect, it } from "vitest";
import { evaluateRegex } from "./regexEvaluation";

it("keeps editor capture expansion and suffix semantics", () => {
  const matches = evaluateRegex({
    text: "ab",
    spec: {
      search: "(a)(b)",
      replace: "$& $$ $1 $2 $12 $3",
      regexp: true,
      caseSensitive: true,
      wholeWord: false,
      literal: false,
    },
  });
  expect(matches).toEqual([{ from: 0, to: 2, insert: "ab $ a b a2 $3" }]);
});

it("preserves the existing handling of an unmatched capture", () => {
  const matches = evaluateRegex({
    text: "b",
    spec: {
      search: "(a)?(b)",
      replace: "$1-$2",
      regexp: true,
      caseSensitive: true,
      wholeWord: false,
      literal: false,
    },
  });
  expect(matches).toEqual([{ from: 0, to: 1, insert: "undefined-b" }]);
});

it("refuses repeated captures that exceed the replacement budget", () => {
  expect(() =>
    evaluateRegex({
      text: "a".repeat(5 * 1024 * 1024),
      spec: {
        search: "a+",
        replace: "$&$&",
        regexp: true,
        caseSensitive: true,
        wholeWord: false,
        literal: false,
      },
    }),
  ).toThrow("16 MiB");
});
