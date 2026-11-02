import { afterEach, expect, it } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function build(env: Record<string, string>, release = true) {
  const root = mkdtempSync(join(tmpdir(), "oarlock-cli-build-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "tools"));
  mkdirSync(join(root, "src-tauri"));
  cpSync(
    new URL("../build-cli.mjs", import.meta.url),
    join(root, "scripts/build-cli.mjs"),
  );
  const tool = (name: string, source: string) =>
    writeFileSync(
      join(root, "tools", name),
      `#!${process.execPath}\n${source}`,
      { mode: 0o755 },
    );
  tool("rustc", 'console.log("host: aarch64-apple-darwin");');
  tool(
    "cargo",
    `
    const fs = require("node:fs");
    const path = require("node:path");
    const args = process.argv.slice(2);
    const workspace = path.dirname(args[args.indexOf("--manifest-path") + 1]);
    const output = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(workspace, "target");
    if (args[0] === "metadata") { console.log(JSON.stringify({ target_directory: output })); }
    else {
      const target = args[args.indexOf("--target") + 1];
      const artifact = path.join(output, target, args.includes("--release") ? "release" : "debug", "oarlock-cli" + (target.includes("windows") ? ".exe" : ""));
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(artifact, target);
    }
  `,
  );
  if (env.CARGO_TARGET_DIR && env.OARLOCK_CLI_TARGET) {
    const stale = join(
      root,
      "src-tauri/target",
      env.OARLOCK_CLI_TARGET,
      "release/oarlock-cli",
    );
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "stale artifact");
  }
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/build-cli.mjs"), ...(release ? ["--release"] : [])],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${join(root, "tools")}:${process.env.PATH}`,
        TAURI_ENV_TARGET_TRIPLE: "",
        OARLOCK_CLI_TARGET: "",
        CARGO_BUILD_TARGET: "",
        CARGO_TARGET_DIR: "",
        ...env,
      },
    },
  );
  return {
    root,
    result,
    artifact: (target: string) =>
      join(
        root,
        "src-tauri/binaries",
        `oarlock-cli-${target}${target.includes("windows") ? ".exe" : ""}`,
      ),
  };
}

// Fake compiler executables use Unix shebang dispatch; no actual cross compiler is required.
it.skipIf(process.platform === "win32")(
  "packages the Tauri target instead of the build host",
  () => {
    const run = build({ TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin" });
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(existsSync(run.artifact("x86_64-apple-darwin"))).toBe(true);
    expect(readFileSync(run.artifact("x86_64-apple-darwin"), "utf8")).toBe(
      "x86_64-apple-darwin",
    );
    expect(existsSync(run.artifact("aarch64-apple-darwin"))).toBe(false);
  },
);
it.skipIf(process.platform === "win32")(
  "reads the fresh artifact from Cargo's configured output directory",
  () => {
    const run = build({
      OARLOCK_CLI_TARGET: "x86_64-unknown-linux-gnu",
      CARGO_TARGET_DIR: "custom-output",
    });
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(readFileSync(run.artifact("x86_64-unknown-linux-gnu"), "utf8")).toBe(
      "x86_64-unknown-linux-gnu",
    );
  },
);
it.skipIf(process.platform === "win32")(
  "keeps standalone development and Windows sidecar naming",
  () => {
    const run = build({ OARLOCK_CLI_TARGET: "x86_64-pc-windows-msvc" }, false);
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(readFileSync(run.artifact("x86_64-pc-windows-msvc"), "utf8")).toBe(
      "x86_64-pc-windows-msvc",
    );
  },
);
