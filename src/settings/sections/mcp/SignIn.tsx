import { Button } from "@/components/ui/button";
import {
  type AuthStatus,
  authStatusText,
  MCP_AUTH_EVENT,
} from "@/modules/mcp/lib/auth";
import {
  type McpServerConfig,
  usesSignIn,
  launchKey,
} from "@/modules/mcp/lib/config";
import { MCP_RESTART_EVENT } from "@/modules/mcp/lib/status";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DiscoveryQueue } from "./discoveryQueue";
import { requestMetadataProbe } from "./metadataProbe";

function shell(): string | null {
  return usePreferencesStore.getState().terminalShell || null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The client a server's configuration gives sign-in, as the backend takes it. */
function clientInput(server: McpServerConfig) {
  const t = server.transport;
  if (t.type === "stdio" || !t.oauth) return null;
  return {
    clientId: t.oauth.clientId,
    hasSecret: t.oauth.clientSecret,
    scopes: t.oauth.scopes,
    callbackPort: t.oauth.callbackPort,
  };
}

function urlOf(server: McpServerConfig): string {
  return server.transport.type === "stdio" ? "" : server.transport.url;
}

export type SignInControls = {
  statuses: Record<string, AuthStatus>;
  errors: Record<string, string>;
  discoveryErrors: Record<string, string>;
  retryDiscovery: (server: McpServerConfig) => void;
  signIn: (server: McpServerConfig) => void;
  signOut: (server: McpServerConfig) => void;
  cancel: (server: McpServerConfig) => void;
};

/**
 * The sign-in state of every remote server Settings lists. The backend runs
 * sign-in and keeps the tokens; this only reads what it says (never a token)
 * and asks it to start or end one. A server that publishes protected resource
 * metadata is probed once, so it shows "Sign in required" before it fails.
 */
export function useSignIn(servers: readonly McpServerConfig[]): SignInControls {
  const [statuses, setStatuses] = useState<Record<string, AuthStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [discoveryResults, setDiscoveryErrors] = useState<
    Record<string, { key: string; error: string }>
  >({});
  const revision = useRef(0);
  const actions = useRef(new Map<string, symbol>());
  const remote = useMemo(() => servers.filter(usesSignIn), [servers]);
  const latest = useRef(remote);
  latest.current = remote;

  const discovery = useRef<DiscoveryQueue | null>(null);
  if (!discovery.current)
    discovery.current = new DiscoveryQueue(
      (server, signal) => requestMetadataProbe(server, signal, shell()),
      (server, result) => {
        if (
          !latest.current.some(
            (s) =>
              s.id === server.id &&
              s.enabled &&
              launchKey(s) === launchKey(server),
          )
        )
          return;
        setDiscoveryErrors((old) => {
          const next = { ...old };
          if (result instanceof Error)
            next[server.id] = { key: launchKey(server), error: result.message };
          else delete next[server.id];
          return next;
        });
        if (!(result instanceof Error))
          setStatuses((old) => ({ ...old, [server.id]: result }));
      },
    );
  const queue = discovery.current;

  const refresh = useCallback(async () => {
    const request = ++revision.current;
    const list = latest.current;
    const current = () =>
      request === revision.current && list === latest.current;
    if (list.length === 0) {
      setStatuses({});
      return;
    }
    const next = await invoke<AuthStatus[]>("mcp_oauth_status", {
      servers: list.map((s) => ({ serverId: s.id, url: urlOf(s) })),
      shell: shell(),
    }).catch(() => null);
    if (!current()) return;
    if (next) setStatuses(Object.fromEntries(next.map((s) => [s.serverId, s])));
    if (next) queue.sync(list, next);
  }, [queue]);

  useEffect(() => {
    queue.reconcile(remote);
    setDiscoveryErrors((old) => {
      const current = new Map(remote.map((server) => [server.id, server]));
      const entries = Object.entries(old).filter(([id, entry]) => {
        const server = current.get(id);
        return server?.enabled && launchKey(server) === entry.key;
      });
      return entries.length === Object.keys(old).length
        ? old
        : Object.fromEntries(entries);
    });
    if (remote.length > 0) void refresh();
  }, [remote, refresh, queue]);

  useEffect(() => {
    queue.open();
    const stop = listen(MCP_AUTH_EVENT, () => void refresh());
    return () => {
      ++revision.current;
      queue.close();
      void stop.then((fn) => fn()).catch(() => {});
    };
  }, [refresh, queue]);

  const owns = useCallback(
    (server: McpServerConfig) =>
      latest.current.some(
        (s) => s.id === server.id && launchKey(s) === launchKey(server),
      ),
    [],
  );
  const begin = useCallback(
    (server: McpServerConfig, token = Symbol()) => {
      ++revision.current;
      queue.suspend(server);
      setDiscoveryErrors(({ [server.id]: _, ...rest }) => rest);
      actions.current.set(server.id, token);
      setErrors(({ [server.id]: _, ...rest }) => rest);
      return () => actions.current.get(server.id) === token && owns(server);
    },
    [owns, queue],
  );

  const signIn = useCallback(
    (server: McpServerConfig) => {
      const current = begin(server);
      void invoke<AuthStatus>("mcp_oauth_sign_in", {
        serverId: server.id,
        url: urlOf(server),
        client: clientInput(server),
        revision: server.secretsRevision,
        shell: shell(),
      }).then(
        (status) => {
          if (current()) {
            begin(server);
            queue.resume(server.id);
            setStatuses((old) => ({ ...old, [server.id]: status }));
          }
          // Windows that run it reconnect with the new sign-in.
          if (owns(server))
            void emit(MCP_RESTART_EVENT, { serverId: server.id });
        },
        (error) => {
          if (!current()) return;
          queue.resume(server.id);
          setErrors((old) => ({ ...old, [server.id]: errorText(error) }));
          void refresh();
        },
      );
    },
    [refresh, begin, owns, queue],
  );

  const signOut = useCallback(
    (server: McpServerConfig) => {
      const current = begin(server);
      void invoke("mcp_oauth_sign_out", { serverId: server.id }).then(
        () => {
          if (!current()) return;
          queue.resume(server.id);
          void emit(MCP_RESTART_EVENT, { serverId: server.id });
          void refresh();
        },
        (error) => {
          if (current()) {
            queue.resume(server.id);
            setErrors((old) => ({ ...old, [server.id]: errorText(error) }));
            void refresh();
          }
        },
      );
    },
    [refresh, begin, queue],
  );

  const cancel = useCallback(
    (server: McpServerConfig) => {
      // A rejected cancel must not suppress the sign-in that is already saving.
      const current = begin(server, actions.current.get(server.id));
      void invoke("mcp_oauth_cancel", { serverId: server.id })
        .then(() => {
          if (current()) {
            begin(server);
            queue.resume(server.id);
            void refresh();
          }
        })
        .catch((error) => {
          if (current()) {
            queue.resume(server.id);
            setErrors((old) => ({ ...old, [server.id]: errorText(error) }));
            void refresh();
          }
        });
    },
    [begin, refresh, queue],
  );

  const retryDiscovery = (server: McpServerConfig) => {
    queue.retry(server.id);
    setDiscoveryErrors(({ [server.id]: _, ...rest }) => rest);
    void refresh();
  };
  return {
    statuses,
    errors,
    discoveryErrors: Object.fromEntries(
      remote.flatMap((server) => {
        const entry = discoveryResults[server.id];
        return entry && entry.key === launchKey(server) && server.enabled
          ? [[server.id, entry.error]]
          : [];
      }),
    ),
    retryDiscovery,
    signIn,
    signOut,
    cancel,
  };
}

/** The sign-in row of an expanded remote server. */
export function SignInRow({
  status,
  error,
  onSignIn,
  onSignOut,
  onCancel,
  discoveryError,
  onRetryDiscovery,
}: {
  status: AuthStatus | undefined;
  error: string | undefined;
  onSignIn: () => void;
  onSignOut: () => void;
  onCancel: () => void;
  discoveryError?: string;
  onRetryDiscovery?: () => void;
}) {
  const now = Date.now();
  const signedIn = status?.state === "signed-in";
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          Sign-in
        </span>
        <span
          className={
            status?.state === "required" && !status.signingIn
              ? "text-[10.5px] leading-relaxed text-amber-700 dark:text-amber-400"
              : "text-[10.5px] leading-relaxed text-muted-foreground"
          }
        >
          {status ? authStatusText(status, now) : "Checking…"}
        </span>
        {discoveryError ? (
          <span className="text-[10.5px] leading-relaxed text-destructive">
            Sign-in discovery failed: {discoveryError}
            <Button
              size="sm"
              variant="ghost"
              className="ml-1 h-6 px-2 text-[11px]"
              onClick={onRetryDiscovery}
            >
              Retry discovery
            </Button>
          </span>
        ) : null}
        {error ? (
          <span className="text-[10.5px] leading-relaxed text-destructive">
            {error}
          </span>
        ) : null}
        <span className="text-[10px] leading-relaxed text-muted-foreground/80">
          Sign-in opens your browser. Oarlock keeps the tokens in your system
          keychain and adds them to this server's requests itself; the agent and
          the app's pages never see them.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {status?.signingIn ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={onCancel}
            disabled={status.saving}
          >
            {status.saving ? "Saving…" : "Cancel"}
          </Button>
        ) : (
          <>
            {signedIn ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={onSignOut}
              >
                Sign out
              </Button>
            ) : null}
            <Button
              size="sm"
              variant={signedIn ? "outline" : "default"}
              className="h-6 px-2 text-[11px]"
              onClick={onSignIn}
            >
              {signedIn ? "Sign in again" : "Sign in"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
