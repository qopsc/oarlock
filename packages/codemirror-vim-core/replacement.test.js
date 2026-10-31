import { expect, it } from "vitest";
import { expandVimReplacement } from "./replacement.js";
function upstream(template, match) {
  return template.replace(/\$(\d{1,3}|[$&])/g, (_, x) => {
    if (x === "$") return "$";
    if (x === "&") return match[0];
    let x1 = x;
    while (parseInt(x1) >= match.length && x1.length > 0) x1 = x1.slice(0, -1);
    return x1 ? match[x1] + x.slice(x1.length) : _;
  });
}
it("preserves Vim capture, missing capture, literal dollar and numbered suffix behavior", () => {
  for (const match of [["abc", "a", "b"], ["abc", undefined, ""], ["x"]])
    for (const template of [
      "$&/$0/$1/$2/$3",
      "$$-$10-$12-$1234",
      "$01/$99/hello",
      "before$1after\n$&",
    ])
      expect(expandVimReplacement(template, match)).toBe(
        upstream(template, match),
      );
});
it("bounds expanding repeated captures before allocating their full output", () => {
  expect(() =>
    expandVimReplacement("$&".repeat(20), ["a".repeat(1_000_000)]),
  ).toThrow("16 MiB");
  expect(() => expandVimReplacement("x".repeat(4097), ["x"])).toThrow("4,096");
});
