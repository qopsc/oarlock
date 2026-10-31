import { beginChatWork } from "../lib/chatWork";
import { tool } from "ai";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { z } from "zod";
import { native as defaultNative } from "../lib/native";
import { checkShellCommand } from "../lib/security";
import type { ToolContext } from "./context";
import { currentWorkspaceEnv, workspaceScopeKey } from "@/modules/workspace";

/**
 * Per-session lazy shell-session id. The agent gets one persistent shell per
 * chat session, so cwd survives across tool calls (cd, mkdir+cd, etc).
 */
const sessionShells = new Map<string, Promise<number>>();

function getSessionShell(
  sessionId: string,
  cwd: string | null,
  native: typeof defaultNative,
  chatId: string,
): Promise<number> {
  let p = sessionShells.get(sessionId);
  if (!p) {
    p = native.shellSessionOpen(cwd, chatId).catch((error) => {
      sessionShells.delete(sessionId);
      throw error;
    });
    sessionShells.set(sessionId, p);
  }
  return p;
}

type ShellClosure = { close: () => Promise<void>; pending?: Promise<void> };
const closures = new Map<string, Map<number, ShellClosure>>();
function closeShell(
  sessionId: string,
  shellId: number,
  native: typeof defaultNative,
): Promise<void> {
  const group = closures.get(sessionId) ?? new Map<number, ShellClosure>();
  closures.set(sessionId, group);
  let entry = group.get(shellId);
  if (!entry) {
    entry = { close: () => native.shellSessionClose(shellId) };
    group.set(shellId, entry);
  }
  if (entry.pending) return entry.pending;
  const closure = entry;
  const pending = closure
    .close()
    .then(() => {
      group.delete(shellId);
      if (group.size === 0) closures.delete(sessionId);
    })
    .finally(() => {
      closure.pending = undefined;
    });
  closure.pending = pending;
  return pending;
}
export async function settleShellClosures(sessionId: string): Promise<void> {
  // Native Stop also removes idle sessions. Never reuse their cached handles.
  const opened: Promise<void>[] = [];
  for (const [key, shell] of sessionShells) {
    if (JSON.parse(key)[0] !== sessionId) continue;
    sessionShells.delete(key);
    opened.push(
      shell.then(
        (id) => closeShell(sessionId, id, defaultNative),
        () => {},
      ),
    );
  }
  await Promise.all(opened);
  const group = closures.get(sessionId);
  if (!group) return;
  await Promise.all(
    [...group.entries()].map(async ([shellId, entry]) => {
      if (entry.pending) await entry.pending;
      else {
        await entry.close();
        group.delete(shellId);
      }
    }),
  );
  if (group.size === 0) closures.delete(sessionId);
}

export function buildShellTools(ctx: ToolContext) {
  const native = ctx.native ?? defaultNative;
  return {
    bash_run: tool({
      description:
        "Run a foreground shell command in this session's persistent agent shell. cwd persists across calls (so `cd foo` then `bash_run pwd` works). Use for short-lived commands (lint, test, search, build). For long-running programs (dev servers, watch tasks), use `bash_background` in foreground mode. Never daemonize, call setsid, or self-detach; use the opt-in `bash_detach` tool instead. NEVER invoke interactive tools (vim, less, top) — they will hang. Asks for user approval.",
      inputSchema: z.object({
        command: z.string(),
        timeout_secs: z.number().int().min(1).max(300).optional(),
      }),
      execute: async ({ command, timeout_secs }, { abortSignal }) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        const finished = beginChatWork(sid);
        try {
          abortSignal?.throwIfAborted();
          const cwd = ctx.getCwd();
          const key = JSON.stringify([
            sid,
            workspaceScopeKey(ctx.workspace ?? currentWorkspaceEnv()),
            ctx.spaceId ?? ctx.getWorkspaceRoot(),
          ]);
          const opened = getSessionShell(key, cwd, native, sid);
          const shellId = await opened;
          const cancel = () => {
            if (sessionShells.get(key) === opened) sessionShells.delete(key);
            void closeShell(sid, shellId, native).catch((error) =>
              console.error("Could not stop shell command", error),
            );
          };
          if (abortSignal?.aborted) {
            cancel();
            abortSignal.throwIfAborted();
          }
          abortSignal?.addEventListener("abort", cancel, { once: true });
          let r: Awaited<ReturnType<typeof native.shellSessionRun>>;
          try {
            r = await native.shellSessionRun(
              shellId,
              command,
              cwd,
              timeout_secs,
            );
          } finally {
            abortSignal?.removeEventListener("abort", cancel);
          }
          abortSignal?.throwIfAborted();
          return {
            command,
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
            timed_out: r.timed_out,
            truncated: r.truncated,
            cwd_after: r.cwd_after,
            ...(r.cwd_error ? { error: r.cwd_error } : {}),
          };
        } catch (e) {
          return { error: String(e) };
        } finally {
          finished();
        }
      },
    }),

    bash_background: tool({
      description:
        "Spawn a long-running background process (e.g. `pnpm dev`, `cargo watch`, log tailers). Returns a handle; use `bash_logs` to read its output and `bash_kill` to stop it. Programs must remain in foreground mode: do not use daemon flags, setsid, or self-detachment. Use bash_detach for explicitly unmanaged launches when enabled. Output is captured into a 4MB ring buffer. At most 16 jobs may run at once across the app; stop a job or wait if the limit is reached. Asks for user approval.",
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().nullable().optional(),
      }),
      execute: async ({ command, cwd }, { abortSignal }) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        const effectiveCwd = cwd ?? ctx.getCwd();
        const finished = beginChatWork(ctx.getSessionId());
        try {
          abortSignal?.throwIfAborted();
          const handle = await native.shellBgSpawn(
            command,
            effectiveCwd,
            ctx.getSessionId(),
          );
          // Stop may have beaten the spawn reply and the native bulk cleanup.
          if (
            abortSignal?.aborted &&
            usePreferencesStore.getState().aiStopBackgroundJobs
          ) {
            await native.shellBgKill(handle);
            abortSignal.throwIfAborted();
          }
          return { handle, command, cwd: effectiveCwd, ok: true };
        } catch (e) {
          return { error: String(e) };
        } finally {
          finished();
        }
      },
    }),

    bash_detach: tool({
      description:
        "Launch an explicitly unmanaged command or daemon. Requires Allow unmanaged detached commands in Settings > Agents. No captured logs, Stop control, or job-limit tracking; it may outlive Oarlock. The returned PID is the launcher, not a managed job handle. Requires the same approval as shell commands.",
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().nullable().optional(),
      }),
      execute: async ({ command, cwd }, { abortSignal }) => {
        if (!usePreferencesStore.getState().aiAllowUnmanagedJobs)
          return {
            error: "Unmanaged launches are disabled in Settings > Agents.",
          };
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        const finished = beginChatWork(ctx.getSessionId());
        try {
          abortSignal?.throwIfAborted();
          const pid = await native.shellDetachedSpawn(
            command,
            cwd ?? ctx.getCwd(),
          );
          return {
            pid,
            unmanaged: true,
            message:
              "No managed handle, logs, Stop control, or job-limit tracking. This command may outlive Oarlock.",
          };
        } catch (error) {
          return { error: String(error) };
        } finally {
          finished();
        }
      },
    }),

    bash_logs: tool({
      description:
        "Read accumulated logs from a `bash_background` process. Pass `since_offset` from the previous response's `next_offset` to tail incrementally. `dropped` reports bytes evicted by the ring buffer. Only the latest 32 finished jobs retain logs; an expired handle returns an error.",
      inputSchema: z.object({
        handle: z.number().int(),
        since_offset: z.number().int().optional(),
      }),
      execute: async ({ handle, since_offset }) => {
        try {
          const r = await native.shellBgLogs(handle, since_offset);
          return r;
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    bash_list: tool({
      description:
        "List all background processes spawned by `bash_background` in this app — running and the latest 32 finished jobs. **Always call this BEFORE spawning a new long-running process** (especially dev servers like `pnpm dev`, `next dev`, `vite`) to avoid duplicates. If a matching process is already running, reuse it (call `open_preview` again instead of respawning). Auto-executes.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const list = await native.shellBgList();
          return { processes: list };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    bash_kill: tool({
      description:
        "Terminate a `bash_background` process by handle. Idempotent — kills nothing if the handle is unknown or already exited.",
      inputSchema: z.object({ handle: z.number().int() }),
      execute: async ({ handle }) => {
        try {
          await native.shellBgKill(handle);
          return { handle, ok: true };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}
