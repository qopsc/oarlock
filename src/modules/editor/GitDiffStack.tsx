import { WorkspaceOwner } from "@/modules/workspace/owner";
import { LOCAL_WORKSPACE } from "@/modules/workspace/env";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import type { GitCommitFileDiffTab, GitDiffTab, Tab } from "@/modules/tabs";
import { GitDiffPane } from "./GitDiffPane";

type Props = {
  tabs: Tab[];
  activeId: number;
};

export function GitDiffStack({ tabs, activeId }: Props) {
  const spaces = useSpaces((s) => s.spaces);
  const active = tabs.find(
    (t): t is GitDiffTab | GitCommitFileDiffTab =>
      (t.kind === "git-diff" || t.kind === "git-commit-file") &&
      t.id === activeId,
  );
  if (!active) return null;
  const workspace =
    spaces.find((s) => s.id === active.spaceId)?.env ?? LOCAL_WORKSPACE;
  if (active.kind === "git-diff") {
    return (
      <div className="h-full w-full">
        <WorkspaceOwner key={active.id} env={workspace}>
          <GitDiffPane
            key={active.id}
            active
            source={{
              kind: "working",
              repoRoot: active.repoRoot,
              path: active.path,
              mode: active.mode,
              originalPath: active.originalPath,
            }}
          />
        </WorkspaceOwner>
      </div>
    );
  }
  return (
    <div className="h-full w-full">
      <WorkspaceOwner key={active.id} env={workspace}>
        <GitDiffPane
          key={active.id}
          active
          source={{
            kind: "commit",
            repoRoot: active.repoRoot,
            sha: active.sha,
            path: active.path,
            originalPath: active.originalPath,
          }}
          chipLabel={active.shortSha}
        />
      </WorkspaceOwner>
    </div>
  );
}
