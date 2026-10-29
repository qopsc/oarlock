import { WorkspaceOwner } from "@/modules/workspace/owner";
import { LOCAL_WORKSPACE } from "@/modules/workspace/env";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import type { GitHistoryTab, Tab } from "@/modules/tabs";
import { GitHistoryPane, type GitHistorySearchHandle } from "./GitHistoryPane";

type CommitFileDiffOpenInput = {
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

type Props = {
  tabs: Tab[];
  activeId: number;
  onOpenCommitFile: (input: CommitFileDiffOpenInput) => void;
  onSearchHandle?: (handle: GitHistorySearchHandle | null) => void;
};

export function GitHistoryStack({
  tabs,
  activeId,
  onOpenCommitFile,
  onSearchHandle,
}: Props) {
  const spaces = useSpaces((s) => s.spaces);
  const active = tabs.find(
    (t): t is GitHistoryTab => t.kind === "git-history" && t.id === activeId,
  );
  if (!active) return null;
  const workspace =
    spaces.find((s) => s.id === active.spaceId)?.env ?? LOCAL_WORKSPACE;
  return (
    <WorkspaceOwner key={active.id} env={workspace}>
      <GitHistoryPane
        key={active.id}
        repoRoot={active.repoRoot}
        onOpenCommitFile={onOpenCommitFile}
        onSearchHandle={onSearchHandle}
      />
    </WorkspaceOwner>
  );
}
