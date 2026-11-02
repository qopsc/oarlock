import { describe, expect, it } from "vitest";
import { boundedReplace } from "./bounded-replacement.js";
import { evaluate } from "./regex-worker.js";

describe("bounded Vim replacement", () => {
  const samples = ["", "abc abc", "é😀a😀", "aba\naba", "a", "zzz"];
  const patterns = [
    /a/,
    /a/g,
    /(a)(b)?/g,
    /(?<first>a)(?<second>b)?/g,
    /^/gm,
    /$/gm,
    /(?=a)/g,
    /(?:)/gu,
    /./gu,
    /a/y,
  ];
  const replacements = [
    "x",
    "$$",
    "$&",
    "$1-$2-$9-$12-$01-$00",
    "$`/$'",
    "$<first>:$<second>:$<missing>",
    "before$&after",
  ];
  for (const value of samples)
    for (const query of patterns)
      for (const replacement of replacements) {
        it(`${JSON.stringify(value)} ${query} ${JSON.stringify(replacement)}`, () => {
          const clone = () => new RegExp(query.source, query.flags);
          expect(boundedReplace(value, clone(), replacement)).toBe(
            value.replace(clone(), replacement),
          );
        });
      }
  it("rejects an expansion before joining oversized captures", () => {
    expect(() =>
      boundedReplace("a".repeat(5 * 1024 * 1024), /a+/, "$&$&"),
    ).toThrow("16 MiB");
  });
  it("applies the same bound through the worker entry point", () => {
    expect(() =>
      evaluate({
        text: "",
        kind: "replace",
        source: "a+",
        flags: "",
        value: "a".repeat(5 * 1024 * 1024),
        replacement: "$&$&",
      }),
    ).toThrow("16 MiB");
  });
});
