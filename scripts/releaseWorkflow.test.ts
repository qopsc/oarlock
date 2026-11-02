import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const verify = named("codesign --verify --deep --strict");
  const upload = named("Upload the verified macOS bundle");
  expect(build).toBeGreaterThan(-1);
  expect(build).toBeLessThan(verify);
  expect(verify).toBeLessThan(upload);
  expect(steps[verify]).toContain("name: Verify the packaged macOS app signature");
  expect(steps[verify]).toContain("if: startsWith(matrix.platform, 'macos')");
  expect(steps[verify]).toContain("set -euo pipefail");
  expect(steps[verify]).toContain("jq -r .identifier src-tauri/tauri.conf.json");
  expect(steps[verify]).toContain("-R=\"anchor apple generic and certificate leaf[subject.OU] = ");
  expect(steps[verify]).toContain("$APPLE_TEAM_ID");
  expect(steps[verify]).toContain("certificate leaf[field.1.2.840.113635.100.6.1.13]");
  expect(steps[verify]).toContain("certificate 1[field.1.2.840.113635.100.6.2.6]");
  expect(steps[verify]).toContain("identifier \\\"$id\\\"");
  expect(steps[build]).not.toMatch(/tagName|releaseDraft|releaseId/);
  expect(steps[upload]).toContain("steps.tauri-mac.outputs.artifactPaths");
  // A directory is never handed to `gh release upload`; the .app is tarred under a
  // per-architecture name, and plain files (the .dmg) go up as they are.
  expect(steps[upload]).toContain('if [ -d "$artifact" ]');
  expect(steps[upload]).toContain('tar -czf "$archive"');
  expect(steps[upload]).toContain('${stem}_${ARCH}.app.tar.gz');
  expect(steps[upload]).toContain("x86_64) ARCH=x64 ;;");
  expect(steps[upload]).toContain('*) ARCH="${ARCH_TARGET%%-*}" ;;');
  // Both legs resolve to distinct names: Oarlock_x64.app.tar.gz and Oarlock_aarch64.app.tar.gz.
  const arch = (target: string) =>
    spawnSync("bash", ["-c", `case "\${T%%-*}" in x86_64) A=x64 ;; *) A="\${T%%-*}" ;; esac; echo "$A"`], {
      encoding: "utf8", env: { ...process.env, T: target },
    }).stdout.trim();
  expect(arch("x86_64-apple-darwin")).toBe("x64");
  expect(arch("aarch64-apple-darwin")).toBe("aarch64");
  expect(steps[upload]).toContain("ARCH_TARGET: ${{ matrix.rust-target }}");
  const publishing = steps.filter((step) => /tagName:/.test(step));
  expect(publishing).toHaveLength(1);
  expect(publishing[0]).toContain("!startsWith(matrix.platform, 'macos')");
});

it("the signature check needs a team id and exactly one app, and hands codesign requirement text", () => {
  const workflow = readFileSync(path.resolve(".github/workflows/release.yml"), "utf8");
  const step = workflow
    .split(/\n {6}(?=- )/)
    .find((candidate) => candidate.includes("name: Verify the packaged macOS app signature"));
  const script = step && /run: \|\n((?:          .*\n?)+)/.exec(step)?.[1];
  if (!script) throw new Error("the signature verification step is missing");
  const target = "aarch64-apple-darwin";
  const arrange = (apps: string[]) => {
    const cwd = mkdtempSync(path.join(tmpdir(), "oarlock-verify-"));
    const bundle = path.join(cwd, "src-tauri/target", target, "release/bundle/macos");
    mkdirSync(bundle, { recursive: true });
    for (const app of apps) mkdirSync(path.join(bundle, app));
    writeFileSync(path.join(cwd, "src-tauri/tauri.conf.json"), '{"identifier":"test.example.app"}');
    const bin = path.join(cwd, "bin");
    mkdirSync(bin);
    const stub = path.join(bin, "codesign");
    writeFileSync(stub, `#!/bin/bash\nprintf '%s\\n' "$@" > "${cwd}/codesign-args"\n`);
    chmodSync(stub, 0o755);
    return cwd;
  };
  const run = (cwd: string, team: string | undefined) =>
    spawnSync("bash", ["-c", script], {
      cwd, encoding: "utf8",
      env: {
        ...process.env, PATH: `${path.join(cwd, "bin")}:${process.env.PATH}`,
        OARLOCK_RELEASE_TARGET: target, APPLE_TEAM_ID: team ?? "",
      },
    });

  const ok = arrange(["Oarlock.app"]);
  expect(run(ok, "ABCDE12345").status).toBe(0);
  const args = readFileSync(path.join(ok, "codesign-args"), "utf8").split("\n");
  expect(args.slice(0, 3)).toEqual(["--verify", "--deep", "--strict"]);
  expect(args[3]).toBe(
    '-R=anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345" and identifier "test.example.app"' +
      " and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate 1[field.1.2.840.113635.100.6.2.6]",
  );
  expect(args[4]).toMatch(/Oarlock\.app$/);

  for (const team of [undefined, "", "abcde12345", "ABCDE1234", "ABCDE123456"]) {
    expect(run(arrange(["Oarlock.app"]), team).status, String(team)).not.toBe(0);
  }
  expect(run(arrange([]), "ABCDE12345").status).not.toBe(0);
  const two = run(arrange(["One.app", "Two.app"]), "ABCDE12345");
  expect(two.status).not.toBe(0);
  expect(two.stderr).toContain("exactly one packaged app");
});
