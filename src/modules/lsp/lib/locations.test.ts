import { expect, it } from "vitest";
import { type DefinitionResult, normalizeLocations } from "./locations";

const range = { start: { line: 2, character: 3 } };
it("keeps valid locations and follows a link's selection range", () => {
  const selected = { start: { line: 4, character: 1 } };
  expect(normalizeLocations({ uri: "file:///repo/a.ts", range })).toEqual([
    { uri: "file:///repo/a.ts", range },
  ]);
  expect(
    normalizeLocations([
      {
        targetUri: "file:///repo/b.ts",
        targetRange: range,
        targetSelectionRange: selected,
      },
    ]),
  ).toEqual([{ uri: "file:///repo/b.ts", range: selected }]);
});

it("ignores malformed server locations instead of throwing during navigation", () => {
  const received = [
    null,
    7,
    "bad",
    {},
    { uri: null, range },
    { uri: "file:///a", range: null },
    { uri: "file:///a", range: { start: { line: -1, character: 0 } } },
    { uri: "file:///a", range: { start: { line: 0, character: NaN } } },
  ];
  expect(normalizeLocations(received as unknown as DefinitionResult)).toEqual(
    [],
  );
});
