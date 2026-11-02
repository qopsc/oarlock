import { expect, it } from "vitest";
import { findCommitFileDiffTab, type GitCommitFileDiffTab } from "./useTabs";

const tab = (id: number, spaceId: string): GitCommitFileDiffTab => ({
  id, spaceId, kind: "git-commit-file", title: "file @ abc", repoRoot: "/repo",
  sha: "abcdef", shortSha: "abc", subject: "change", path: "file", originalPath: null,
});
const input = { repoRoot: "/repo", sha: "abcdef", path: "file" };

it("reuses commit-file diffs only within the owning space", () => {
  const other = tab(1, "debian");
  const own = tab(2, "ubuntu");
  expect(findCommitFileDiffTab([other], input, "ubuntu")).toBeUndefined();
  expect(findCommitFileDiffTab([other, own], input, "ubuntu")).toBe(own);
  expect(findCommitFileDiffTab([own], { ...input, sha: "different" }, "ubuntu")).toBeUndefined();
});
