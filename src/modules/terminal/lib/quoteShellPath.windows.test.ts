import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/platform", () => ({ IS_WINDOWS: true }));
import { quoteShellPath } from "./quoteShellPath";

it.skipIf(process.platform === "win32")(
  "keeps a Windows filename literal in its target POSIX shell",
  () => {
    const path = "C:\\Temp\\picture$(printf oarlock-probe) with spaces.png";
    const result = spawnSync(
      "/bin/sh",
      ["-c", `printf '%s' ${quoteShellPath(path, "posix")}`],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(path);
  },
);
