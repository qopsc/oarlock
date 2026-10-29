import { useOwnedWorkspace } from "@/modules/workspace/owner";
import { useRepositoryOwner } from "@/modules/source-control/useRepositoryOwner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { type GitLogEntry, createNative } from "@/modules/ai/lib/native";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { showFileError } from "@/modules/mac-privacy";

type Props = {
  repoRoot: string;
  /** The commit to undo, with the branch it is the tip of; null when closed. */
  target: { commit: GitLogEntry; branch: string } | null;
  onClose: () => void;
  onUndone: () => void;
};

/**
 * Confirms undoing the newest commit of a branch (`git reset --soft HEAD~1`).
 * The changes go back to the staged list, so nothing is lost, but a commit
 * that is already on a remote branch gets a warning first.
 */
export function UndoCommitDialog({
  repoRoot,
  target,
  onClose,
  onUndone,
}: Props) {
  const workspace = useOwnedWorkspace();
  const native = useMemo(() => createNative(() => workspace), [workspace]);
  const owner = useRepositoryOwner(repoRoot);
  const sha = target?.commit.sha ?? null;
  const [remoteCheck, setRemoteCheck] = useState<{
    sha: string;
    repoRoot: string;
    remote: string | null;
    failed: boolean;
    attempt: number;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const currentCheck =
    remoteCheck?.sha === sha &&
    remoteCheck.repoRoot === repoRoot &&
    remoteCheck.attempt === retry
      ? remoteCheck
      : null;
  const pushedTo = currentCheck?.remote;
  const checkReady = currentCheck !== null && !currentCheck.failed;

  useEffect(() => {
    setRemoteCheck(null);
    if (!sha) return;
    let alive = true;
    native
      .gitCommitOnRemote(repoRoot, sha)
      .then((remote) => {
        if (alive)
          setRemoteCheck({
            sha,
            repoRoot,
            remote,
            failed: false,
            attempt: retry,
          });
      })
      .catch(() => {
        if (alive)
          setRemoteCheck({
            sha,
            repoRoot,
            remote: null,
            failed: true,
            attempt: retry,
          });
      });
    return () => {
      alive = false;
    };
  }, [native, repoRoot, sha, retry]);

  const undo = async () => {
    if (!target || !checkReady || !owner.isCurrent()) return;
    const { commit, branch } = target;
    onClose();
    try {
      await native.gitUndoCommit(repoRoot, commit.sha, branch);
      if (!owner.isCurrent()) return;
      toast.success(`Undid ${commit.shortSha} on ${branch}`, {
        description: "Its changes are staged again.",
      });
      onUndone();
    } catch (e) {
      if (!owner.isCurrent()) return;
      showFileError("Could not undo the commit", {
        path: repoRoot,
        error: e,
        description: String(e),
      });
    }
  };

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Undo commit?</AlertDialogTitle>
          <AlertDialogDescription>
            {target
              ? `"${target.commit.subject || target.commit.shortSha}" is removed from ${target.branch}, and its changes go back to the staged list.`
              : null}
            {pushedTo
              ? ` It is already on ${pushedTo}: pushing ${target?.branch} afterwards rewrites history others may have.`
              : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {currentCheck?.failed ? (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>
              Could not check whether this commit is shared. Retry before
              undoing it.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry check
            </Button>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={pushedTo ? "destructive" : "default"}
            disabled={!checkReady}
            onClick={() => void undo()}
          >
            Undo Commit
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
