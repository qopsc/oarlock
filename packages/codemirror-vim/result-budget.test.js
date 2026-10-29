import { expect, it } from "vitest";
import { checkResultBudget, validateResult } from "./result-budget.js";
it("rejects repeated large captures before serialization allocates their expansion", () => {
  const part = "a".repeat(1_000_000);
  expect(() => checkResultBudget(Array(20).fill(part))).toThrow("16 MiB");
});
it("refuses malformed and out-of-document worker ranges", () => {
  const request = { kind: "cursor" };
  expect(() =>
    validateResult(request, { from: 0, to: 8, match: ["a"] }, 3),
  ).toThrow("Invalid");
  expect(() =>
    validateResult(request, { from: 0, to: 1, match: [{}] }, 3),
  ).toThrow("Invalid");
  expect(
    validateResult(request, { from: 0, to: 1, match: ["a", undefined] }, 3),
  ).toMatchObject({ from: 0, to: 1 });
});
it("enforces ordered highlight ranges and line result counts", () => {
  expect(() =>
    validateResult(
      { kind: "highlight" },
      [
        { from: 2, to: 3 },
        { from: 0, to: 1 },
      ],
      3,
    ),
  ).toThrow("Invalid");
  expect(() => validateResult({ kind: "lines", lines: ["a"] }, [], 3)).toThrow(
    "Invalid",
  );
});
