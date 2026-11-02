import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it("refuses branch dispatch before the release job can publish", () => {
  const workflow = readFileSync(path.resolve(".github/workflows/release.yml"), "utf8");
  const validation = /validate-release-ref:[\s\S]*?run: \|\n((?:          .*\n)+)/.exec(workflow)?.[1];
  if (!validation) throw new Error("release reference validation is missing");
  expect(workflow).toMatch(/publish-tauri:\n\s+needs: validate-release-ref/);
  const run = (ref: string) => spawnSync("bash", ["-c", validation], {
    encoding: "utf8", env: { ...process.env, GITHUB_REF: ref },
  });
  expect(run("refs/tags/v1.2.3").status).toBe(0);
  const branch = run("refs/heads/main");
  expect(branch.status).not.toBe(0);
  expect(branch.stdout + branch.stderr).toContain("release tag");
  expect(run("refs/tags/not-a-release").status).not.toBe(0);
});

it("verifies the macOS bundle before anything is uploaded to the release", () => {
  const workflow = readFileSync(path.resolve(".github/workflows/release.yml"), "utf8");
  const steps = workflow.split(/\n {6}(?=- )/);
  const named = (needle: string) => steps.findIndex((step) => step.includes(needle));
  const build = named("id: tauri-mac");
  const verify = named("verify-app.mjs");
  const upload = named("Upload the verified macOS bundle");
  expect(build).toBeGreaterThan(-1);
  expect(build).toBeLessThan(verify);
  expect(verify).toBeLessThan(upload);
  expect(steps[build]).not.toMatch(/tagName|releaseDraft|releaseId/);
  expect(steps[upload]).toContain("steps.tauri-mac.outputs.artifactPaths");
  const publishing = steps.filter((step) => /tagName:/.test(step));
  expect(publishing).toHaveLength(1);
  expect(publishing[0]).toContain("!startsWith(matrix.platform, 'macos')");
});
