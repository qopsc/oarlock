import { IS_WINDOWS } from "@/lib/platform";
import { invoke } from "@tauri-apps/api/core";
import { startCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { toast } from "sonner";
import { pathQuery } from "./pathComplete";
import { encodeCompletion, pathInsertionContext, type CompletionOwner } from "./safePathCompletion";

const DOC_WORD_RE = /[A-Za-z_][\w./-]+/g;
type Entry = { name: string; kind: string };

/** Completion work and acceptance retain the exact terminal and editor snapshot. */
export async function ownedPathCompletion(
  ctx: CompletionContext,
  owner: CompletionOwner,
): Promise<CompletionResult | null> {
  const document = ctx.state.doc;
  const selection = ctx.state.selection.main;
  if (!selection.empty || ctx.pos !== selection.head || ctx.state.selection.ranges.length !== 1) return null;
  const current = () => owner.active() && !!ctx.view &&
    ctx.view.state.doc === document && ctx.view.state.selection === ctx.state.selection && ctx.view.state.selection.ranges.length === 1 &&
    ctx.view.state.selection.main.anchor === selection.anchor &&
    ctx.view.state.selection.main.head === selection.head;
  try {
    const shell = await owner.verify();
    if (ctx.aborted || !current()) return null;
    const context = pathInsertionContext(document.toString(), ctx.pos, shell);
    if (!context) return null;
    const style = IS_WINDOWS && owner.workspace.kind === "local" &&
      (shell === "cmd" || shell === "powershell") ? "windows" : "posix";
    const query = pathQuery(context.token, owner.cwd, style);
    if (!query) return null;
    let entries: Entry[] = [];
    try {
      entries = await invoke<Entry[]>("fs_read_dir", {
        path: query.dir, showHidden: query.base.startsWith("."), workspace: owner.workspace,
      });
    } catch {
      // The old editor also offered document words when a directory read failed.
    }
    if (ctx.aborted || !current()) return null;
    const dirs: Completion[] = [];
    const files: Completion[] = [];
    const makeOption = (label: string, insert: string, dir: boolean, type: string): Completion => ({
      label, type,
      apply: (view) => {
        void owner.verify().then((verified) => {
          if (verified !== shell || !current() || view.state.doc !== document) return;
          view.dispatch({ changes: { from: context.from, to: ctx.pos, insert }, selection: { anchor: context.from + insert.length } });
          if (dir) startCompletion(view);
        }).catch(() => { if (owner.active()) toast.error("Cannot verify the terminal shell; completion was not inserted."); });
      },
    });
    for (const entry of entries) {
      if (!entry.name.toLowerCase().startsWith(query.base.toLowerCase())) continue;
      const dir = entry.kind === "dir";
      const insert = encodeCompletion(context.token, entry.name, dir ? query.sep : "", shell);
      if (insert === null) continue;
      (dir ? dirs : files).push(makeOption(entry.name + (dir ? query.sep : ""), insert, dir, dir ? "type" : "variable"));
      if (dirs.length + files.length === 200) break;
    }
    const options = [...dirs, ...files];
    if (!options.length && /^[A-Za-z_][\w./-]*$/.test(context.token) &&
        document.sliceString(context.from, ctx.pos) === context.token) {
      const seen = new Set<string>([context.token]);
      for (const match of document.toString().matchAll(DOC_WORD_RE)) {
        const label = match[0];
        if (seen.has(label)) continue;
        seen.add(label);
        const insert = encodeCompletion("", label, "", shell);
        if (insert) options.push(makeOption(label, insert, false, "text"));
        if (options.length === 200) break;
      }
    }
    return options.length ? { from: context.from, to: ctx.pos, options } : null;
  } catch {
    if (ctx.explicit && owner.active()) toast.error("Cannot verify the terminal shell for path completion.");
    return null;
  }
}
