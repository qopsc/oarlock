import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { type McpServerConfig, parseServers } from "./config";
import { settingsPatches } from "./settingsPatch";
import {
  type ProjectServerRecord,
  type ProjectServers,
  parseRecords,
  projectConfigs,
} from "./projectServers";
import { capText, cleanAnnotations, type McpAnnotations } from "./toolSchema";

/**
 * Servers, what the user chose for project servers, and the tools each listed
 * when it last ran (for Settings).
 */
const KEY_SERVERS = "servers";
const KEY_PROJECT_SERVERS = "projectServers";
const TOOLS_PREFIX = "tools:";
const MAX_KNOWN_TOOLS = 500;

/**
 * Store change events reach only the writing webview, so every write is
 * announced: windows restart what changed, Settings re-reads.
 */
const MCP_CHANGED_EVENT = "oarlock://mcp-changed";
/**
 * What a window may run from its project changes with trust decisions
 * (`project_trust::CHANGED_EVENT`, also sent when a window opens or leaves a
 * project) and with the project's files (`skills::CHANGED_EVENT`).
 */
const PROJECT_EVENTS = [
  "project-trust:changed",
  "skills:changed",
  "mcp:run-leases-changed",
];

export type McpChange =
  | { kind: "servers" }
  | { kind: "tools"; serverId: string };

const snapshot = (key: string): Promise<unknown> =>
  invoke("mcp_settings_snapshot", { key });

export async function loadServers(): Promise<McpServerConfig[]> {
  return parseServers(await snapshot(KEY_SERVERS));
}

export type SecretWrite = {
  kind: "env" | "header" | "oauth";
  name: string;
  value: string;
};

export async function createServers(
  servers: readonly McpServerConfig[],
  secrets: readonly SecretWrite[] = [],
): Promise<void> {
  await invoke("mcp_settings_mutate", {
    changes: servers.map((server) => ({ kind: "create", server, secrets })),
  });
}

export async function updateServer(
  before: McpServerConfig,
  after: McpServerConfig,
  secrets: readonly SecretWrite[] = [],
  fromEditor = false,
): Promise<void> {
  const editable = (server: McpServerConfig) => ({
    name: server.name,
    enabled: server.enabled,
    trusted: server.trusted,
    transport: server.transport,
    tools: server.tools,
  });
  const patches = settingsPatches(editable(before), editable(after));
  if (!patches.length && !secrets.length && !fromEditor) return;
  await invoke("mcp_settings_mutate", {
    changes: [
      {
        kind: "update",
        id: before.id,
        patches,
        secrets,
        expected:
          fromEditor ||
          secrets.length ||
          patches.some((p) => p.path[0] === "transport")
            ? { revision: before.secretsRevision, transport: before.transport }
            : null,
      },
    ],
  });
}

export async function deleteServer(id: string): Promise<void> {
  await invoke("mcp_settings_mutate", { changes: [{ kind: "delete", id }] });
}

export async function loadProjectRecords(): Promise<
  Record<string, ProjectServerRecord>
> {
  return parseRecords(await snapshot(KEY_PROJECT_SERVERS));
}

/** Keeps what the user chose for one project server. */
export async function saveProjectRecord(
  id: string,
  before: ProjectServerRecord,
  after: ProjectServerRecord,
): Promise<void> {
  const editable = ({ enabled, trusted, tools }: ProjectServerRecord) => ({
    enabled,
    trusted,
    tools,
  });
  const patches = settingsPatches(editable(before), editable(after));
  if (!patches.length) return;
  await invoke("mcp_settings_mutate", {
    changes: [{ kind: "project", id, entryHash: after.entryHash, patches }],
  });
}

/**
 * The servers of the calling window's project, or with `all` (Settings) of
 * every open project; listed only while the user allows their `.mcp.json`.
 */
export function listProjectServers(all: boolean): Promise<ProjectServers[]> {
  return invoke<ProjectServers[]>("mcp_project_servers", { all });
}

/** What this window runs: the configured servers and its project's. */
export async function loadWindowServers(
  includeRetained = false,
): Promise<McpServerConfig[]> {
  const [servers, records, projects] = await Promise.all([
    loadServers(),
    loadProjectRecords(),
    listProjectServers(false).catch((error) => {
      console.warn("[mcp] project servers unavailable", error);
      return [];
    }),
  ]);
  return [
    ...servers,
    ...projectConfigs(
      projects.filter((p) => includeRetained || p.active !== false),
      records,
    ),
  ];
}

/** A tool as Settings lists it for per-tool choices. */
export type KnownTool = {
  name: string;
  title?: string;
  description?: string;
  annotations?: McpAnnotations;
};

function cleanKnownTools(raw: unknown): KnownTool[] {
  if (!Array.isArray(raw)) return [];
  const out: KnownTool[] = [];
  for (const entry of raw.slice(0, MAX_KNOWN_TOOLS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, title, description, annotations } = entry as Record<
      string,
      unknown
    >;
    if (typeof name !== "string" || !name) continue;
    out.push({
      name: capText(name, 200),
      ...(typeof title === "string" ? { title: capText(title, 200) } : {}),
      ...(typeof description === "string"
        ? { description: capText(description, 400) }
        : {}),
      ...(cleanAnnotations(annotations)
        ? { annotations: cleanAnnotations(annotations) }
        : {}),
    });
  }
  return out;
}

export async function loadKnownTools(): Promise<Record<string, KnownTool[]>> {
  const out: Record<string, KnownTool[]> = {};
  for (const [key, value] of Object.entries(
    (await snapshot("tools")) as Record<string, unknown>,
  )) {
    if (key.startsWith(TOOLS_PREFIX)) {
      out[key.slice(TOOLS_PREFIX.length)] = cleanKnownTools(value);
    }
  }
  return out;
}

/** One key per server, so windows recording different servers never race. */
export async function saveKnownTools(
  serverId: string,
  tools: readonly KnownTool[],
): Promise<void> {
  const key = `${TOOLS_PREFIX}${serverId}`;
  const next = cleanKnownTools(tools);
  const current = cleanKnownTools(await snapshot(key));
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  await invoke("mcp_settings_mutate", {
    changes: [{ kind: "tools", id: serverId, tools: next }],
  });
}

export async function forgetKnownTools(serverId: string): Promise<void> {
  await invoke("mcp_settings_mutate", {
    changes: [{ kind: "tools", id: serverId, tools: null }],
  });
}

/** Configuration changes, and changes of what the open projects provide. */
export async function onMcpChanged(
  handler: (change: McpChange) => void,
): Promise<UnlistenFn> {
  const registrations = await Promise.allSettled([
    listen<McpChange>(MCP_CHANGED_EVENT, (event) => handler(event.payload)),
    ...PROJECT_EVENTS.map((name) =>
      listen(name, () => handler({ kind: "servers" })),
    ),
  ]);
  const stops = registrations.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const failure = registrations.find((result) => result.status === "rejected");
  if (failure) {
    for (const stop of stops) stop();
    throw failure.reason;
  }
  return () => {
    for (const stop of stops) stop();
  };
}
