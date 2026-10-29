import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceEnv } from "@/modules/workspace/env";
import { formatDroppedPaths, type DropShell } from "./quoteShellPath";

type Prepared = { shell: DropShell; paths: string[] };
export async function prepareShellPathDrop(
  id: number,
  paths: readonly string[],
  source: WorkspaceEnv,
  active: () => boolean,
  insert: (text: string) => void,
  prepare = (args: {
    id: number;
    paths: readonly string[];
    source: WorkspaceEnv;
  }) => invoke<Prepared>("pty_prepare_path_drop", args),
): Promise<void> {
  if (!active()) return;
  const result = await prepare({ id, paths, source });
  if (!active()) return;
  insert(formatDroppedPaths(result.paths, result.shell));
}
