import { describe, expect, it } from "vitest";
import { filledArguments, missingArguments } from "./argumentsForm";

const fields = [
  { name: "code", label: "Code", required: true },
  { name: "style", label: "Style", required: false },
];

describe("prompt and template arguments", () => {
  it("requires required fields", () => {
    expect(missingArguments(fields, { code: "  ", style: "x" })).toEqual({
      code: "This is required.",
    });
    expect(missingArguments(fields, { code: "x" })).toEqual({});
  });

  it("sends only filled-in fields", () => {
    expect(filledArguments(fields, { code: "x", style: " " })).toEqual({
      code: "x",
    });
  });
});

it("preserves prototype-named arguments and required errors", () => {
  const fields = [{ name: "__proto__", label: "Value", required: true }];
  expect(
    Object.keys(
      missingArguments(fields, Object.fromEntries([["__proto__", ""]])),
    ),
  ).toEqual(["__proto__"]);
  expect(
    JSON.stringify(
      filledArguments(fields, Object.fromEntries([["__proto__", "answer"]])),
    ),
  ).toBe('{"__proto__":"answer"}');
});
