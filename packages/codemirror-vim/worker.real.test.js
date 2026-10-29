import { spawnSync } from "node:child_process";
import { it, expect } from "vitest";
it("kills a real hostile Vim regex worker and admits the next search", () => {
  const result = spawnSync("bun", ["scripts/vim-review/worker-probe.mjs"], {
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
