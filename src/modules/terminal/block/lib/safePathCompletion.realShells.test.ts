import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { DropShell } from "../../lib/quoteShellPath";
import { encodeCompletion } from "./safePathCompletion";

const names = ["space name", "$(printf injected)", "`printf injected`", "a;b&c", "a'b", "λ-file", "-leading"];
const available = (name: string) => spawnSync("which", [name], { stdio: "ignore" }).status === 0;

describe.each([
  { executable: "/bin/sh", dialect: "posix" as DropShell },
  { executable: "bash", dialect: "posix" as DropShell },
  { executable: "zsh", dialect: "posix" as DropShell },
  { executable: "fish", dialect: "fish" as DropShell },
])("literal arguments in $executable", ({ executable, dialect }) => {
  it.skipIf(process.platform === "win32" || !available(executable))("passes each filename as one literal argument", () => {
    for (const name of names) {
      const text = encodeCompletion("", name, "", dialect);
      expect(text).not.toBeNull();
      const result = spawnSync(executable, ["-c", `printf '%s' ${text}`], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(name);
    }
  });
});

it.skipIf(!available("pwsh"))("passes literal arguments to PowerShell", () => {
  for (const name of names) {
    const text = encodeCompletion("", name, "", "powershell");
    expect(text).not.toBeNull();
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::Write(${text})`], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(name);
  }
});
