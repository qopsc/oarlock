import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatDroppedPaths, quoteShellPath } from "./quoteShellPath";

describe("literal shell path arguments", () => {
  const paths = [
    "/tmp/a b",
    "/tmp/it's a file",
    "/tmp/a\\b",
    "C:\\Temp\\picture$(printf oarlock-probe) with spaces.png",
    "/tmp/`echo surprise`",
    "/tmp/$HOME;echo nope",
    "/tmp/a!b%PATH%",
  ];
  for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh"]) {
    it.skipIf(!existsSync(shell))(`preserves paths with ${shell}`, () => {
      for (const path of paths) {
        const result = spawnSync(
          shell,
          ["-c", `printf '%s' ${quoteShellPath(path, "posix")}`],
          { encoding: "utf8" },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(path);
      }
    });
  }
  it("uses fish literal escapes", () => {
    expect(quoteShellPath("/tmp/a\\b'c", "fish")).toBe("'/tmp/a\\\\b\\'c'");
  });
  it("uses PowerShell literals instead of interpolating quotes", () => {
    expect(quoteShellPath("C:\\it's$(whoami).txt", "powershell")).toBe(
      "'C:\\it''s$(whoami).txt'",
    );
  });
  it("refuses cmd variable expansions even inside quotes", () => {
    for (const path of ["C:\\%PATH%.txt", "C:\\!hello!.txt", 'C:\\a"b'])
      expect(() => quoteShellPath(path, "cmd")).toThrow();
    expect(quoteShellPath("C:\\a & b.txt", "cmd")).toBe('"C:\\a & b.txt"');
  });
  it("rejects unknown shells, empty paths and control characters", () => {
    for (const path of ["", "/tmp/a\nb", "/tmp/a\u001bb", "/tmp/a\u0000b"])
      expect(() => quoteShellPath(path, "posix")).toThrow();
    expect(() => quoteShellPath("/tmp/a", "unknown" as never)).toThrow();
  });
  it("formats all arguments before insertion", () => {
    expect(formatDroppedPaths(["/a/b", "/c/d e"], "posix")).toBe(
      "'/a/b' '/c/d e' ",
    );
    expect(() => formatDroppedPaths([], "posix")).toThrow();
  });
});
