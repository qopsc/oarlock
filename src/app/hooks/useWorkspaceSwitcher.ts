import { useCallback, useEffect, useRef, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { native } from "@/modules/ai/lib/native";
import { useSpaces } from "@/modules/spaces";
import { planEnvSwitch } from "@/modules/spaces/lib/activeSpace";
import {
  authorizeRoot,
  getWslHome,
  LOCAL_WORKSPACE,
  type WorkspaceEnv,
} from "@/modules/workspace";

async function resolveEnvHome(env: WorkspaceEnv): Promise<string> {
  return env.kind === "wsl"
    ? getWslHome(env.distro)
    : (await homeDir()).replace(/\\/g, "/");
}

type Params = {
  setWorkspaceEnv: (env: WorkspaceEnv) => void;
  newTab: (cwd?: string) => number;
  setActiveSpaceForNewTabs: (id: string) => void;
};

/**
 * Owns the resolved home / launch cwd. switchWorkspace answers the status-bar
 * environment picker (Windows): it moves to a space with that environment, or
 * opens one at its home, so no shell or tab of any space is closed;
 * adoptWorkspaceEnv applies a space's env + home when it becomes active.
 */
export function useWorkspaceSwitcher({
  setWorkspaceEnv,
  newTab,
  setActiveSpaceForNewTabs,
}: Params) {
  const generation = useRef(0);
  const switchRequest = useRef(0);
  const [home, setHome] = useState<string | null>(null);
  const [launchCwd, setLaunchCwd] = useState<string | null>(null);
  const [launchCwdResolved, setLaunchCwdResolved] = useState(false);

  useEffect(() => {
    const version = generation.current;
    let disposed = false;
    homeDir()
      .then((p) => {
        if (disposed || version !== generation.current) return;
        const normalized = p.replace(/\\/g, "/");
        void authorizeRoot(normalized, LOCAL_WORKSPACE);
        setHome(normalized);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const version = generation.current;
    let disposed = false;
    native
      .workspaceCurrentDir()
      .then((cwd) => {
        if (!disposed && version === generation.current) setLaunchCwd(cwd);
      })
      .catch(() => {})
      .finally(() => {
        if (!disposed) setLaunchCwdResolved(true);
      });
    return () => {
      disposed = true;
      generation.current++;
    };
  }, []);

  const switchWorkspace = useCallback(
    async (env: WorkspaceEnv): Promise<void> => {
      const version = generation.current;
      const request = ++switchRequest.current;
      const spaces = useSpaces.getState();
      const plan = planEnvSwitch(spaces.spaces, spaces.activeId, env);
      if (plan.kind === "stay") return;
      if (plan.kind === "activate") {
        spaces.setActive(plan.spaceId);
        return;
      }
      let nextHome: string;
      try {
        nextHome = await resolveEnvHome(env);
      } catch (e) {
        if (version === generation.current && request === switchRequest.current)
          window.alert(String(e));
        return;
      }
      if (
        version !== generation.current ||
        request !== switchRequest.current ||
        useSpaces.getState().activeId !== spaces.activeId
      )
        return;
      // Before the tab mounts: its shell starts in the window's environment.
      setWorkspaceEnv(env.kind === "local" ? LOCAL_WORKSPACE : env);
      const meta = useSpaces
        .getState()
        .create({ name: plan.name, root: nextHome, env });
      setActiveSpaceForNewTabs(meta.id);
      newTab(nextHome);
      useSpaces.getState().setActive(meta.id);
    },
    [setWorkspaceEnv, newTab, setActiveSpaceForNewTabs],
  );

  const adoptWorkspaceEnv = useCallback(
    async (env: WorkspaceEnv): Promise<string | null> => {
      const version = ++generation.current;
      setHome(null);
      setLaunchCwd(null);
      setWorkspaceEnv(env.kind === "local" ? LOCAL_WORKSPACE : env);
      let nextHome: string;
      try {
        nextHome = await resolveEnvHome(env);
      } catch {
        return null;
      }
      if (version !== generation.current) return null;
      const authorized = await authorizeRoot(nextHome, env);
      if (version !== generation.current || !authorized) return null;
      setHome(nextHome);
      setLaunchCwd(nextHome);
      return nextHome;
    },
    [setWorkspaceEnv],
  );

  return {
    home,
    launchCwd,
    launchCwdResolved,
    switchWorkspace,
    adoptWorkspaceEnv,
  };
}
