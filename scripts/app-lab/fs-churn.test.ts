import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("refuses an existing destination without deleting its contents", () => {
  const root = mkdtempSync(join(tmpdir(), "oarlock-churn-review-"));
  const sentinel = join(root, "keep.txt");
  writeFileSync(sentinel, "unsaved work");
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "fs-churn.mjs"),
        "prepare",
        root,
        join(root, "missing-source"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(readFileSync(sentinel, "utf8")).toBe("unsaved work");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
