import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("installs the bundled CLI next to the app executable", () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(root, "package.nix"), "utf8");
  const phase = /installPhase = if stdenv\.hostPlatform\.isLinux then ''\n([\s\S]*?)\n  '' else ''/.exec(source)?.[1];
  if (!phase) throw new Error("Linux install phase not found");
  const dir = mkdtempSync(path.join(tmpdir(), "oarlock-nix-package-"));
  try {
    mkdirSync(path.join(dir, "usr/bin"), { recursive: true });
    mkdirSync(path.join(dir, "usr/share/applications"), { recursive: true });
    writeFileSync(path.join(dir, "usr/bin/oarlock"), "app");
    writeFileSync(path.join(dir, "usr/bin/oarlock-cli"), "cli");
    writeFileSync(path.join(dir, "usr/share/applications/oarlock.desktop"), "desktop");
    const script = `set -e\ninstall() { mkdir -p "$(dirname "$3")"; cp "$2" "$3"; chmod 755 "$3"; }\nwrapProgram() { test -x "$1"; }\ngappsWrapperArgs=()\n${phase.replaceAll("''${", "${")}`;
    execFileSync("bash", ["-c", script], { cwd: dir, env: { ...process.env, out: path.join(dir, "out"), GST_PLUGIN_SYSTEM_PATH: "" } });
    expect(existsSync(path.join(dir, "out/bin/oarlock-cli"))).toBe(true);
    expect(readFileSync(path.join(dir, "out/bin/oarlock-cli"), "utf8")).toBe("cli");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
