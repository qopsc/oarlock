import { createContext, useContext, useRef, type ReactNode } from "react";
import { currentWorkspaceEnv, type WorkspaceEnv } from "./env";

import { workspaceUnavailableReason } from "./availability";

const Owner = createContext<WorkspaceEnv | null>(null);

/** A resource keeps its environment across navigation and asynchronous work. */
export function WorkspaceOwner({
  env,
  children,
}: {
  env: WorkspaceEnv;
  children: ReactNode;
}) {
  const initial = useRef(env);
  const unavailable = workspaceUnavailableReason(initial.current);
  if (unavailable)
    return (
      <p role="status" className="p-6 text-sm text-muted-foreground">
        {unavailable}
      </p>
    );
  return <Owner value={initial.current}>{children}</Owner>;
}

export function useOwnedWorkspace(): WorkspaceEnv {
  const owner = useContext(Owner);
  const fallback = useRef(currentWorkspaceEnv());
  return owner ?? fallback.current;
}
