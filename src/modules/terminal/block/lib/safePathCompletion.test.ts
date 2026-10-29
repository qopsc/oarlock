import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { encodeCompletion, pathInsertionContext } from "./safePathCompletion";
import type { DropShell } from "../../lib/quoteShellPath";

describe("literal shell path completions", () => {
  it.each(["space name", "$(printf injected)", "`printf injected`", "a;b&c", "a'b", "a\\b", "λ-file", "-leading"])("passes %s as one literal POSIX argument", (name) => {
    const insert = encodeCompletion("", name, "", "posix");
    expect(insert).not.toBeNull();
    const result = spawnSync("/bin/sh", ["-c", `printf '%s' ${insert}`], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(name);
  });
  it.each(["posix", "fish", "powershell", "cmd"] as DropShell[])("can complete an inserted directory again for %s", (shell) => {
    const dir = encodeCompletion("", "a b", "/", shell);
    const text = `cat ${dir}`;
    expect(pathInsertionContext(text, text.length, shell)).toEqual({ from: 4, token: "a b/" });
  });
  it.each(['cat "unfinished', "cat 'unfinished", "cat $(x)", "cat a;echo", "cat a|b", "cat `x`", "cat a\nb"])("refuses ambiguous POSIX input %s", (text) => {
    expect(pathInsertionContext(text, text.length, "posix")).toBeNull();
  });
  it("rejects mid-token insertion and invalid command contexts", () => {
    expect(pathInsertionContext("cat filename", 7, "posix")).toBeNull();
    expect(pathInsertionContext("filename", 8, "posix")).toBeNull();
  });
  it("keeps POSIX quoting literal across quotes and backslashes", () => {
    const dir = encodeCompletion("", "it's\\here", "/", "posix");
    const text = `cat ${dir}`;
    expect(pathInsertionContext(text, text.length, "posix")?.token).toBe("it's\\here/");
  });
  it("refuses cmd expansion characters instead of producing unsafe quoting", () => {
    expect(encodeCompletion("", "%PATH%", "", "cmd")).toBeNull();
    expect(encodeCompletion("", "a!b", "", "cmd")).toBeNull();
  });
});
