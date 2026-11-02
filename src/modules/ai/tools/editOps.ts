export type EditOp = {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};

export type EditOpsResult =
  | { ok: true; content: string; replacements: number }
  | { ok: false; error: string };

/** Applies `edits` in order to a running buffer; the first one that cannot
 *  apply rejects the whole batch. */
export function applyEditOps(
  original: string,
  edits: readonly EditOp[],
): EditOpsResult {
  let content = original;
  let replacements = 0;
  for (const e of edits) {
    if (e.old_string === e.new_string) {
      return { ok: false, error: "old_string and new_string are identical" };
    }
    if (e.old_string.length === 0) {
      return { ok: false, error: "old_string cannot be empty" };
    }
    if (e.replace_all) {
      let n = 0;
      let i = 0;
      while ((i = content.indexOf(e.old_string, i)) !== -1) {
        n++;
        i += e.old_string.length;
      }
      if (n === 0) return { ok: false, error: notFound(e.old_string) };
      content = content.split(e.old_string).join(e.new_string);
      replacements += n;
      continue;
    }
    const first = content.indexOf(e.old_string);
    if (first === -1) return { ok: false, error: notFound(e.old_string) };
    if (content.indexOf(e.old_string, first + 1) !== -1) {
      return {
        ok: false,
        error:
          "old_string is not unique. Provide more surrounding context, or set replace_all=true.",
      };
    }
    content =
      content.slice(0, first) +
      e.new_string +
      content.slice(first + e.old_string.length);
    replacements += 1;
  }
  return { ok: true, content, replacements };
}

function notFound(oldString: string): string {
  return `old_string not found: ${JSON.stringify(oldString.slice(0, 80))}`;
}
