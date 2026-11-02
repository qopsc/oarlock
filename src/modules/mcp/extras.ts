import { loadWindowServers } from "./lib/configStore";
import { useMcpExtras } from "./lib/extrasCatalog";
import type { CompletionRef } from "./runtime";

export type { CompletionRef } from "./runtime";

/**
 * What the composer asks of the window's MCP servers: start them for its
 * `@` and `/` lists, read a resource, get a prompt, ask for completions.
 * Light like `index.ts`: the client loads only once a server is enabled.
 */

let runtime: Promise<typeof import("./runtime")> | null = null;

function loadRuntime(): Promise<typeof import("./runtime")> {
  runtime ??= import("./runtime").catch((error) => {
    runtime = null;
    throw error;
  });
  return runtime;
}

let preparing: Promise<void> | null = null;

/**
 * Starts the window's enabled servers when the composer first lists what
 * they offer (with none enabled it only reads the configuration). Never
 * fails for pickers; strict callers report a failure instead of sending raw text.
 */
export function ensureMcpExtras(strict = false): Promise<void> {
  preparing ??= (async () => {
    const { setStarting } = useMcpExtras.getState();
    try {
      const servers = await loadWindowServers();
      if (!runtime && !servers.some((s) => s.enabled)) return;
      await (await loadRuntime()).prepareExtras(servers, () =>
        setStarting(true),
      );
    } catch (error) {
      console.warn("[mcp] servers unavailable for the composer", error);
      throw error;
    } finally {
      setStarting(false);
      preparing = null;
    }
  })();
  return strict ? preparing : preparing.catch(() => {});
}

export async function readMcpResource(
  serverId: string,
  uri: string,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const runtime = await loadRuntime();
  signal?.throwIfAborted();
  return runtime.extras().read(serverId, uri, signal);
}

/** Fills in a resource template and reads what it names. */
export async function readMcpTemplate(
  serverId: string,
  uriTemplate: string,
  values: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ uri: string; result: unknown }> {
  signal?.throwIfAborted();
  const extras = (await loadRuntime()).extras();
  signal?.throwIfAborted();
  const uri = extras.expand(uriTemplate, values);
  return { uri, result: await extras.read(serverId, uri, signal) };
}

export async function getMcpPrompt(
  serverId: string,
  name: string,
  args: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const runtime = await loadRuntime();
  signal?.throwIfAborted();
  return runtime.extras().getPrompt(serverId, name, args, signal);
}

export async function completeMcpArgument(
  serverId: string,
  ref: CompletionRef,
  argument: { name: string; value: string },
  context: Record<string, string>,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!runtime || signal?.aborted) return [];
  const loaded = await runtime;
  if (signal?.aborted) return [];
  return loaded.extras().complete(serverId, ref, argument, context, signal);
}
