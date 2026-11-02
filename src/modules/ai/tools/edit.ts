import { tool } from "ai";
import { z } from "zod";
import { native as defaultNative } from "../lib/native";
import { StaleFileError } from "../lib/staleFile";
import { checkWritableCanonical } from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { resolvePath, type ToolContext } from "./context";
import { applyEditOps } from "./editOps";
import { contentHash, writtenEntry } from "./readCache";

type EditResult =
  | { ok: true; replacements: number; bytesWritten: number; path: string }
  | {
      ok: true;
      replacements: number;
      queued_for_plan_review: true;
      path: string;
    }
  | { error: string; path: string };

async function applyEdits(
  abs: string,
  edits: { old_string: string; new_string: string; replace_all?: boolean }[],
  kind: "edit" | "multi_edit",
  ctx: ToolContext,
): Promise<EditResult> {
  const native = ctx.native ?? defaultNative;
  const readCache = ctx.readCache;
  const r = await native.readFile(abs, { versioned: true });
  if (r.kind === "binary") return { error: "binary file refused", path: abs };
  if (r.kind === "toolarge")
    return { error: `file too large (${r.size} bytes)`, path: abs };

  const original = r.content;
  if (typeof r.version !== "string") {
    return { error: "could not version the file; try again", path: abs };
  }
  const prior = readCache.get(abs);
  const fullContent =
    prior?.fullContent === true &&
    prior.size === r.size &&
    prior.hash === contentHash(original);
  const applied = applyEditOps(original, edits);
  if (!applied.ok) return { error: applied.error, path: abs };
  const content = applied.content;
  const totalReplacements = applied.replacements;

  if (usePlanStore.getState().active) {
    usePlanStore.getState().enqueue({
      workspace: ctx.workspace,
      id: newQueuedEditId(),
      kind,
      path: abs,
      originalContent: original,
      proposedContent: content,
      isNewFile: false,
      baseVersion: r.version,
      edits,
    });
    return {
      ok: true,
      replacements: totalReplacements,
      queued_for_plan_review: true,
      path: abs,
    };
  }

  try {
    const saved = await native.writeFile(abs, content, r.version);
    const entry = { ...writtenEntry(content, saved.version), fullContent };
    readCache.set(abs, entry);
    return {
      ok: true,
      replacements: totalReplacements,
      bytesWritten: entry.size,
      path: abs,
    };
  } catch (err) {
    return {
      error: err instanceof StaleFileError ? err.message : String(err),
      path: abs,
    };
  }
}

export function buildEditTools(ctx: ToolContext) {
  const native = ctx.native ?? defaultNative;
  return {
    edit: tool({
      description:
        "Replace an exact string in a file. Requires read_file on this path first in the current session — this prevents blind edits. `old_string` must be unique in the file unless `replace_all: true`. Asks for user approval before writing.",
      inputSchema: z.object({
        path: z.string(),
        old_string: z
          .string()
          .describe(
            "Exact substring to replace. Must be unique unless replace_all.",
          ),
        new_string: z.string().describe("Replacement substring."),
        replace_all: z.boolean().optional(),
      }),
      execute: async ({ path, old_string, new_string, replace_all }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(
          reqPath,
          native.canonicalize,
        );
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        if (!ctx.readCache.has(abs)) {
          return {
            error:
              "must call read_file on this path first (read-before-edit invariant).",
            path: abs,
          };
        }
        return applyEdits(
          abs,
          [{ old_string, new_string, replace_all }],
          "edit",
          ctx,
        );
      },
    }),

    multi_edit: tool({
      description:
        "Apply several exact-string replacements to a single file atomically. Each edit is applied in order to the running buffer; if any edit's old_string is missing or non-unique, the whole batch aborts before writing. Requires prior read_file on the path. Asks for user approval before writing.",
      inputSchema: z.object({
        path: z.string(),
        edits: z
          .array(
            z.object({
              old_string: z.string(),
              new_string: z.string(),
              replace_all: z.boolean().optional(),
            }),
          )
          .min(1),
      }),
      execute: async ({ path, edits }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(
          reqPath,
          native.canonicalize,
        );
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        if (!ctx.readCache.has(abs)) {
          return {
            error:
              "must call read_file on this path first (read-before-edit invariant).",
            path: abs,
          };
        }
        return applyEdits(abs, edits, "multi_edit", ctx);
      },
    }),
  } as const;
}
