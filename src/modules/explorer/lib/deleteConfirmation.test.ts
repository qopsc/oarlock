import { expect, it } from "vitest";
import { confirmedDeletePaths } from "./deleteConfirmation";

it("only accepts the workspace and selection the user confirmed", () => {
  const first = {};
  const other = {};
  const pending = { scope: first, paths: ["/repo/a", "/repo/b"] };
  expect(confirmedDeletePaths(pending, first, ["/repo/b", "/repo/a"]))
    .toEqual(["/repo/a", "/repo/b"]);
  expect(confirmedDeletePaths(pending, other, ["/repo/a", "/repo/b"]))
    .toBeNull();
  expect(confirmedDeletePaths(pending, first, ["/repo/a", "/repo/c"]))
    .toBeNull();
  expect(confirmedDeletePaths(pending, first, ["/repo/a"]))
    .toBeNull();
});
