import { tool } from "ai";
import { z } from "zod";
import { native as defaultNative } from "../lib/native";
import { StaleFileError } from "../lib/staleFile";
import {
  checkReadableCanonical,
  checkWritableCanonical,
} from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { resolvePath, type ToolContext } from "./context";
import { contentHash, writtenEntry } from "./readCache";
import { textWindow } from "./textWindow";

export function buildFsTools(ctx: ToolContext) {
  const native = ctx.native ?? defaultNative;
  return {
    read_file: tool({
      description:
        "Read a UTF-8 text file. Defaults to the first 2000 lines (capped at 25KB). Pass `offset`/`limit` for line-based windowing of large files. Refuses binary, oversized, or sensitive files (.env, keys, credentials). If you call this on the same path twice in a session without edits in between, the second call returns `unchanged: true` instead of re-emitting the content — re-read the prior tool result.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, or relative to the active terminal cwd."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based start line. Default 0."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe("Max lines to return. Default 2000."),
      }),
      execute: async ({ path, offset, limit }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkReadableCanonical(
          reqPath,
          native.canonicalize,
        );
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        try {
          const r = await native.readFile(abs, { versioned: true });
          if (r.kind === "binary")
            return { error: "binary file refused", path: abs, size: r.size };
          if (r.kind === "toolarge")
            return {
              error: `file too large (${r.size} bytes, limit ${r.limit})`,
              path: abs,
            };

          const hash = contentHash(r.content);
          const isFullRead = offset === undefined && limit === undefined;
          const prior = ctx.readCache.get(abs);
          if (
            isFullRead &&
            prior?.fullContent &&
            prior.size === r.size &&
            prior.hash === hash
          ) {
            return { path: abs, unchanged: true, size: r.size };
          }
          const window = textWindow(r.content, offset, limit);
          // A hash proves which file was read, not how much the model saw.
          // Keep partial reads eligible for edits without suppressing unseen text.
          const fullContent =
            (window.startLine === 0 && !window.truncated) ||
            (prior?.fullContent === true &&
              prior.size === r.size &&
              prior.hash === hash);
          ctx.readCache.set(abs, {
            size: r.size,
            hash,
            fullContent,
            version: r.version,
          });
          if (isFullRead) {
            return {
              path: abs,
              content: window.content,
              size: r.size,
              total_lines: window.totalLines,
              ...(window.truncated
                ? {
                    truncated: true,
                    hint: "call read_file with offset to continue",
                  }
                : {}),
            };
          }
          return {
            path: abs,
            content: window.content,
            size: r.size,
            total_lines: window.totalLines,
            start_line: window.startLine,
            end_line: window.endLine,
            ...(window.truncated ? { truncated: true } : {}),
          };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    list_directory: tool({
      description:
        "List immediate entries (files + directories) in a directory. Hidden entries are omitted.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, or relative to the active terminal cwd."),
      }),
      execute: async ({ path }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkReadableCanonical(
          reqPath,
          native.canonicalize,
        );
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        try {
          const entries = await native.readDir(abs);
          return {
            path: abs,
            entries: entries.map((e) => ({ name: e.name, kind: e.kind })),
          };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    write_file: tool({
      description:
        "Create or overwrite a file with the given content. Always asks the user before running. Prefer `edit` / `multi_edit` for in-place changes — only use `write_file` for creating a brand-new file or fully replacing a tiny one.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      execute: async ({ path, content }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(
          reqPath,
          native.canonicalize,
        );
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;

        // The version the write must replace: the one the model read, else the
        // one on disk now; null when there is no file (create only).
        let expected: string | null | undefined =
          ctx.readCache.get(abs)?.version;
        let original = "";
        if (expected === undefined) {
          try {
            const r = await native.readFile(abs, { versioned: true });
            if (r.kind !== "text" || typeof r.version !== "string") {
              return {
                error:
                  "cannot overwrite a binary, oversized or unversioned file",
                path: abs,
              };
            }
            original = r.content;
            expected = r.version;
          } catch {
            expected = null;
          }
        }

        if (usePlanStore.getState().active) {
          usePlanStore.getState().enqueue({
            workspace: ctx.workspace,
            id: newQueuedEditId(),
            kind: "write_file",
            path: abs,
            originalContent: original,
            proposedContent: content,
            isNewFile: expected === null,
            baseVersion: expected,
          });
          return {
            path: abs,
            queued_for_plan_review: true,
            ok: true,
          };
        }

        try {
          const saved = await native.writeFile(abs, content, expected);
          const entry = writtenEntry(content, saved.version);
          ctx.readCache.set(abs, entry);
          return { path: abs, bytesWritten: entry.size, ok: true };
        } catch (e) {
          return {
            error: e instanceof StaleFileError ? e.message : String(e),
            path: abs,
          };
        }
      },
    }),

    create_directory: tool({
      description:
        "Create a directory (and any missing parents). Always asks the user before running.",
      inputSchema: z.object({
        path: z.string(),
      }),
      execute: async ({ path }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(
          reqPath,
          native.canonicalize,
        );
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        if (usePlanStore.getState().active) {
          usePlanStore.getState().enqueue({
            workspace: ctx.workspace,
            id: newQueuedEditId(),
            kind: "create_directory",
            path: abs,
            originalContent: "",
            proposedContent: "",
            isNewFile: true,
            baseVersion: null,
            description: "Create directory",
          });
          return { path: abs, queued_for_plan_review: true, ok: true };
        }
        try {
          await native.createDir(abs);
          return { path: abs, ok: true };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),
  } as const;
}
