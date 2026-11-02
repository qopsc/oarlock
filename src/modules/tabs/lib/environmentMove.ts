import type { WorkspaceEnv } from "@/modules/workspace/env";

type Space = { id: string; env?: WorkspaceEnv };
/** Space membership may change; a mounted resource's execution environment may not. */
export function canMoveBetweenSpaces(
  spaces: readonly Space[],
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  const source = spaces.find((space) => space.id === from);
  const target = spaces.find((space) => space.id === to);
  if (!source || !target) return false;
  const a = source.env ?? { kind: "local" },
    b = target.env ?? { kind: "local" };
  return (
    a.kind === b.kind &&
    (a.kind !== "wsl" || (b.kind === "wsl" && a.distro === b.distro))
  );
}
