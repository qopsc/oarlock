import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceEnv } from "@/modules/workspace/env";
import { loadServers, loadProjectRecords } from "./configStore";
import { projectConfigs, type ProjectServers } from "./projectServers";

/** A native lease captures the submitted project, independent of navigation. */
export async function captureRunServers(
  root: string | null,
  workspace: WorkspaceEnv,
  ownLease?: (release: () => Promise<void>) => () => Promise<void>,
) {
  let releaseOwned: (() => Promise<void>) | undefined;
  const opened = invoke<{
    lease: number | null;
    projectKey: string | null;
    projects: ProjectServers[];
  }>("mcp_run_open", { root, workspace })
    .catch((error) => {
      console.warn("[mcp] project servers unavailable", error);
      return { lease: null, projectKey: null, projects: [] };
    })
    .then((run) => {
      if (run.lease !== null)
        releaseOwned = ownLease?.(() =>
          invoke("mcp_run_release", { lease: run.lease }),
        );
      return run;
    });
  let released = false;
  let releasing: Promise<void> | undefined;
  const release = () => {
    if (released) return Promise.resolve();
    releasing ??= opened
      .then(async (run) => {
        if (run.lease !== null)
          await (releaseOwned?.() ??
            invoke("mcp_run_release", { lease: run.lease }));
        released = true;
      })
      .finally(() => {
        releasing = undefined;
      });
    return releasing;
  };
  try {
    const [run, servers, records] = await Promise.all([
      opened,
      loadServers(),
      loadProjectRecords(),
    ]);
    const project = projectConfigs(run.projects, records);
    return {
      retainsProject: run.lease !== null,
      servers: [...servers, ...project],
      offeredIds: new Set([
        ...servers.map((s) => s.id),
        ...project
          .filter((s) => s.projectKey === run.projectKey)
          .map((s) => s.id),
      ]),
      release,
    };
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }
}
