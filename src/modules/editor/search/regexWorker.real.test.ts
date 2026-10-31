import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
it("terminates a real hostile worker and permits a subsequent replacement scan", () => {
  const result = spawnSync("bun", ["scripts/editor-search/worker-probe.mjs"], {
    encoding: "utf8",
    timeout: 8000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    passed: true,
    recovery: true,
  });
});
