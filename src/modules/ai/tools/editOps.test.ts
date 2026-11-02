import { describe, expect, it } from "vitest";
import { applyEditOps } from "./editOps";

describe("applyEditOps", () => {
  it("applies edits in order to the running buffer", () => {
    const r = applyEditOps("a b", [
      { old_string: "a", new_string: "x" },
      { old_string: "x b", new_string: "y" },
    ]);
    expect(r).toEqual({ ok: true, content: "y", replacements: 2 });
  });

  it("counts every replacement of replace_all", () => {
    const r = applyEditOps("z z z", [
      { old_string: "z", new_string: "q", replace_all: true },
    ]);
    expect(r).toEqual({ ok: true, content: "q q q", replacements: 3 });
  });

  it("rejects the batch on the first edit that cannot apply", () => {
    expect(applyEditOps("a a", [{ old_string: "a", new_string: "b" }])).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(
      applyEditOps("a", [{ old_string: "missing", new_string: "b" }]),
    ).toEqual({ ok: false, error: 'old_string not found: "missing"' });
    expect(applyEditOps("a", [{ old_string: "a", new_string: "a" }])).toEqual({
      ok: false,
      error: "old_string and new_string are identical",
    });
    expect(applyEditOps("a", [{ old_string: "", new_string: "a" }])).toEqual({
      ok: false,
      error: "old_string cannot be empty",
    });
  });
});
