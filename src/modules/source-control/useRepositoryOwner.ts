import { useEffect, useRef } from "react";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import {
  currentWorkspaceEnv,
  workspaceScopeKey,
} from "@/modules/workspace/env";

/** A menu/form is remounted for a new repository or space; callbacks keep its owner. */
export function useRepositoryOwner(repoRoot: string | null) {
  const ref = useRef<{
    repoRoot: string | null;
    workspace: ReturnType<typeof currentWorkspaceEnv>;
    spaceId: string | null;
    closed: boolean;
    stale: boolean;
    isCurrent: () => boolean;
  } | null>(null);
  if (!ref.current) {
    const workspace = currentWorkspaceEnv();
    const spaceId = useSpaces.getState().activeId;
    const owner = {
      repoRoot,
      workspace,
      spaceId,
      closed: false,
      stale: false,
      isCurrent: (): boolean =>
        !owner.closed &&
        !owner.stale &&
        useSpaces.getState().activeId === spaceId &&
        workspaceScopeKey(currentWorkspaceEnv()) ===
          workspaceScopeKey(workspace),
    };
    ref.current = owner;
  }
  const owner = ref.current;
  if (owner.repoRoot !== repoRoot || !owner.isCurrent()) owner.stale = true;
  useEffect(() => {
    owner.closed = false;
    return () => {
      owner.closed = true;
    };
  }, [owner]);
  return owner;
}
