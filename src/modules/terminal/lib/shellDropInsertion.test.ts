import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { captureDropInsertion, safeDropBoundary } from "./shellDropInsertion";
import { quoteShellPath } from "./quoteShellPath";

it("accepts complete argument boundaries, including replacement selections", () => {
  expect(safeDropBoundary("cat ", 4, 4)).toBe(true);
  expect(safeDropBoundary("", 0, 0)).toBe(true);
  expect(safeDropBoundary("cat replace me", 4, 14)).toBe(true);
  expect(safeDropBoundary("cat  >out", 4, 4)).toBe(false);
  expect(safeDropBoundary("cat --flag", 3, 3)).toBe(false);
});
it.each([
  'cat "',
  "cat '",
  "cat \\",
  "cat $(",
  "cat `",
  "cat %thing%",
  "cat &",
  "cat\n",
  "cat !x!",
])("refuses ambiguous shell syntax: %s", (text) =>
  expect(safeDropBoundary(text, text.length, text.length)).toBe(false),
);
it.skipIf(process.platform === "win32")(
  "rejects the open-quote case that real sh interprets as a substitution",
  () => {
    const path = "/tmp/$(printf oarlock-probe)";
    const prefix = 'printf "%s" "';
    const result = spawnSync(
      "/bin/sh",
      ["-c", `${prefix}${quoteShellPath(path, "posix")}"`],
      { encoding: "utf8" },
    );
    expect(result.stdout).toContain("oarlock-probe");
    expect(result.stdout).not.toContain("$(printf");
    expect(safeDropBoundary(prefix, prefix.length, prefix.length)).toBe(false);
  },
);
it("invalidates a captured insertion after any editor state change", () => {
  const state = {};
  let current = state;
  const inserted: string[] = [];
  const insert = captureDropInsertion(
    state,
    () => current,
    "cat ",
    [{ from: 4, to: 4 }],
    (text) => inserted.push(text),
  );
  expect(insert?.("'/a' ")).toBe(true);
  current = {};
  expect(insert?.("'/b' ")).toBe(false);
  expect(inserted).toEqual(["'/a' "]);
  expect(
    captureDropInsertion(
      state,
      () => state,
      "",
      [],
      () => {},
    ),
  ).toBeNull();
});
