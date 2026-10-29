import { describe, expect, it } from "vitest";
import { relativePath } from "./contextActions";

describe("relativePath", () => {
  it("returns '.' when the path is the root itself", () => {
    expect(relativePath("/a/b", "/a/b")).toBe(".");
  });

  it("strips the root prefix for a descendant path", () => {
    expect(relativePath("/a/b", "/a/b/c/d")).toBe("c/d");
  });

  it("does not relativize a sibling that only shares the root prefix", () => {
    expect(relativePath("/a/b", "/a/bc/d")).toBe("/a/bc/d");
  });

  it("returns an unrelated path unchanged", () => {
    expect(relativePath("/a/b", "/x/y")).toBe("/x/y");
  });
});

it.each([
  ["/", "/etc/hosts", "etc/hosts"],
  ["C:/", "C:/Users/me/file.txt", "Users/me/file.txt"],
])("copies a relative path from filesystem root %s", (root, path, expected) => {
  expect(relativePath(root, path)).toBe(expected);
});
