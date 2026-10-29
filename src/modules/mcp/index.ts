import { loadWindowServers } from "./lib/configStore";
import { captureRunServers } from "./lib/runServers";
import type { WorkspaceEnv } from "@/modules/workspace/env";
import type { McpRunTools } from "./runtime";

export { mcpCallTarget, useMcpCatalog } from "./lib/catalog";
export { isMcpToolName } from "./lib/toolNames";
export type { McpRunTools } from "./runtime";

let runtime: Promise<typeof import("./runtime")> | null = null;

/**
 * The window's MCP tools for one agent run: the configured servers and those
 * of the window's project its user allows. With no server enabled this reads
 * the configuration and nothing else: the MCP client (the SDK and the
 * runtime) loads only once a server is enabled, and servers start on the
 * first run that needs them. A failure here never fails the run; it costs
 * the run its MCP tools, and the server's status says why.
 */
export async function mcpToolsForRun(
  opts: {
    signal?: AbortSignal;
    onWaiting?: () => void;
    /** Capture configuration now, but start no server until the turn is admitted. */
    admission?: Promise<void>;
    ownLease?: (release: () => Promise<void>) => () => Promise<void>;
    root?: string | null;
    workspace?: WorkspaceEnv;
  } = {},
): Promise<McpRunTools | null> {
  const snapshot = opts.workspace
    ? captureRunServers(opts.root ?? null, opts.workspace, opts.ownLease)
    : loadWindowServers().then((servers) => ({
        servers,
        retainsProject: false,
        offeredIds: new Set(servers.map((s) => s.id)),
        release: async () => {},
      }));
  let transferred = false;
  try {
    const [captured] = await Promise.all([snapshot, opts.admission]);
    const { servers, offeredIds, release } = captured;
    opts.signal?.throwIfAborted();
    if (!runtime && !servers.some((s) => s.enabled)) return null;
    runtime ??= import("./runtime").catch((error) => {
      runtime = null;
      throw error;
    });
    const client = await runtime;
    opts.signal?.throwIfAborted();
    const result = await client.toolsForRun(servers, { ...opts, offeredIds });
    opts.signal?.throwIfAborted();
    if (Object.keys(result.tools).length === 0) return null;
    transferred = captured.retainsProject;
    return captured.retainsProject ? { ...result, release } : result;
  } catch (error) {
    console.warn("[mcp] tools unavailable for this run", error);
    return null;
  } finally {
    if (!transferred)
      await snapshot
        .then((run) => run.release())
        .catch((error) => console.warn("[mcp] run cleanup failed", error));
  }
}
