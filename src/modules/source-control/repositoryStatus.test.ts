import { expect, it } from "vitest";
import { repositoryWithStatus } from "./useSourceControl";

it("uses fresh branch and upstream status while preserving linked-worktree metadata", () => {
  const repo = { repoRoot: "/repo", branch: "old", upstream: null, isDetached: true, linkedWorktree: { name: "worktree", repositoryName: "main" } };
  const status = { repoRoot: "/repo", branch: "main", upstream: "origin/main", isDetached: false,
    ahead: 0, behind: 0, truncated: false, changedFiles: [] };
  expect(repositoryWithStatus(repo, status)).toEqual({
    ...repo, branch: "main", upstream: "origin/main", isDetached: false,
  });
  expect(repositoryWithStatus({ ...repo, upstream: "origin/old" }, { ...status, upstream: null }).upstream).toBeNull();
});
