import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps the production search engine responsive during catastrophic backtracking", () => {
  const result = spawnSync(
    "bun",
    ["scripts/terminal-shell-drop/regex-worker-probe.mjs"],
    { encoding: "utf8", timeout: 8000 },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    deadlinePassed: true,
    recoveryPassed: true,
  });
});
