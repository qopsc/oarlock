import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceEnv } from "@/modules/workspace/env";
import { loadServers, loadProjectRecords } from "./configStore";
import { projectConfigs, type ProjectServers } from "./projectServers";

export type RunScope = {
  /** The native run record the project attaches to (see `ai_run_begin`). */
  runId: string;
  /** Settles once that record exists. */
  ready: Promise<void>;
};

async function openProject(
  scope: RunScope,
  root: string | null,
  workspace: WorkspaceEnv,
) {
  await scope.ready;
  return invoke<{ projectKey: string | null; projects: ProjectServers[] }>(
    "ai_run_mcp_open",
    { runId: scope.runId, root, workspace },
  );
}

/** Clears the run's project: the run has no MCP tools to keep callable. */
export async function clearRunProject(
  scope: RunScope,
  workspace: WorkspaceEnv,
): Promise<void> {
  await openProject(scope, null, workspace).catch(() => {});
}

/** A native run record captures the submitted project, independent of navigation. */
export async function captureRunServers(
  root: string | null,
  workspace: WorkspaceEnv,
  scope?: RunScope,
) {
  const [run, servers, records] = await Promise.all([
    scope
      ? openProject(scope, root, workspace).catch((error) => {
          console.warn("[mcp] project servers unavailable", error);
          return { projectKey: null, projects: [] as ProjectServers[] };
        })
      : Promise.resolve({
          projectKey: null,
          projects: [] as ProjectServers[],
        }),
    loadServers(),
    loadProjectRecords(),
  ]);
  const project = projectConfigs(run.projects, records);
  return {
    servers: [...servers, ...project],
    offeredIds: new Set([
      ...servers.map((s) => s.id),
      ...project
        .filter((s) => s.projectKey === run.projectKey)
        .map((s) => s.id),
    ]),
  };
}
