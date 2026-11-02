import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("typechecks the public entry without generated dist files", () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), "oarlock-vim-types-"));
  try {
    cpSync(path.join(root, "main.d.ts"), path.join(dir, "main.d.ts"));
    const declarations = path.join(root, "declarations");
    if (existsSync(declarations)) cpSync(declarations, path.join(dir, "declarations"), { recursive: true });
    writeFileSync(path.join(dir, "consumer.ts"), 'import { initVim, type Pos } from "./main";\nconst point: Pos = { line: 1, ch: 2 };\nvoid initVim; void point;\n');
    const compiler = path.resolve(root, "../../node_modules/typescript/bin/tsc");
    const check = spawnSync(process.execPath, [compiler, "--ignoreConfig", "--noEmit", "--skipLibCheck", "false", "--lib", "es2022,dom", "--moduleResolution", "bundler", "--module", "esnext", path.join(dir, "consumer.ts")], { encoding: "utf8" });
    expect(check.status, `${check.stdout}\n${check.stderr}`).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
