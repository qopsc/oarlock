import { describe, expect, it } from "vitest";
import {
  isWindowsDrivePath,
  isWindowsPath,
  isWindowsUncPath,
} from "./windowsPath";

describe("windows path predicates", () => {
  it("recognizes a drive path with either separator", () => {
    for (const path of ["C:\\dir", "c:/dir", "D:\\", "Z:/"]) {
      expect(isWindowsDrivePath(path)).toBe(true);
      expect(isWindowsPath(path)).toBe(true);
    }
  });

  it("recognizes a network share path", () => {
    for (const path of ["\\\\server\\share", "\\\\server\\share\\dir"]) {
      expect(isWindowsUncPath(path)).toBe(true);
      expect(isWindowsPath(path)).toBe(true);
      expect(isWindowsDrivePath(path)).toBe(false);
    }
  });

  it("leaves POSIX, relative and drive-relative paths alone", () => {
    for (const path of [
      "/usr/bin",
      "dir\\file",
      "C:dir",
      "C:",
      "//server/x",
      "",
    ]) {
      expect(isWindowsPath(path)).toBe(false);
    }
  });
});
