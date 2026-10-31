import type { WorkspaceEnv } from "@/modules/workspace/env";
import { quoteShellPath, type DropShell } from "../../lib/quoteShellPath";

export type CompletionOwner = {
  cwd: string;
  workspace: WorkspaceEnv;
  active: () => boolean;
  verify: () => Promise<DropShell>;
};

/** Parse only literal shell words. Expansions, operators and incomplete quotes
 * are deliberately rejected. Quoted paths produced by us can be completed again. */
export function pathInsertionContext(text: string, cursor: number, shell: DropShell): {
  from: number;
  token: string;
} | null {
  if (cursor < 0 || cursor > text.length || (cursor < text.length && text[cursor] !== " ")) return null;
  if (!/^[a-zA-Z0-9_./,:=+\\\- ]*$/.test(text.slice(cursor))) return null;
  let from = 0;
  let token = "";
  let words = 0;
  let quote = false;
  let inWord = false;
  const q = shell === "cmd" ? '"' : "'";
  for (let i = 0; i < cursor; i++) {
    const ch = text[i];
    if (!quote && ch === " ") {
      if (inWord) words++;
      inWord = false;
      token = "";
      from = i + 1;
      continue;
    }
    if (!inWord) { from = i; inWord = true; }
    if (ch === q) {
      if (quote && shell === "powershell" && text[i + 1] === q && i + 1 < cursor) {
        token += q; i++; continue;
      }
      quote = !quote;
      continue;
    }
    if (shell === "fish" && quote && ch === "\\") {
      const next = text[++i];
      if (next !== "\\" && next !== "'") return null;
      token += next; continue;
    }
    if (shell === "posix" && !quote && ch === "\\") {
      const next = text[++i];
      if (!next || next === "\n") return null;
      token += next; continue;
    }
    if (!quote && !/[a-zA-Z0-9_./,:=+-]/.test(ch) &&
        !((shell === "cmd" || shell === "powershell") && ch === "\\")) return null;
    if (quote && shell === "cmd" && /[%!\r\n]/.test(ch)) return null;
    if (/[\u0000-\u001f\u007f]/.test(ch)) return null;
    token += ch;
  }
  if (quote || words === 0) return null;
  return { from, token };
}

export function encodeCompletion(token: string, name: string, separator: string, shell: DropShell): string | null {
  const slash = Math.max(token.lastIndexOf("/"), shell === "cmd" || shell === "powershell" ? token.lastIndexOf("\\") : -1);
  const path = token.slice(0, slash + 1) + name + separator;
  try { return quoteShellPath(path, shell); } catch { return null; }
}
