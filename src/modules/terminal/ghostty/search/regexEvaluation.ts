import type { RegexMatch } from "./regexProtocol";

/**
 * Compiles a terminal search pattern: a JavaScript regular expression,
 * case-insensitive unless it contains an upper-case letter (smart case, as in
 * editors). Returns null for an invalid pattern or one that can match empty
 * text (which would highlight every cell).
 */
export function compileTerminalPattern(pattern: string): RegExp | null {
  if (!pattern) return null;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, /\p{Lu}/u.test(pattern) ? "gu" : "giu");
  } catch {
    return null;
  }
  return regex.test("") ? null : regex;
}

/**
 * The matches of `regex` in one line of cells. Cells hold a grapheme each
 * (" " when blank) and "" for the second half of a wide character, so string
 * offsets map back to columns through the cell starts.
 */
export function matchLine(
  cells: readonly string[],
  line: number,
  regex: RegExp,
  limit: number,
): RegexMatch[] {
  let text = "";
  const columnAt: number[] = [];
  for (let column = 0; column < cells.length; column++) {
    const cell = cells[column] ?? "";
    for (let unit = 0; unit < cell.length; unit++) columnAt.push(column);
    text += cell;
  }
  columnAt.push(cells.length);
  const matches: RegexMatch[] = [];
  regex.lastIndex = 0;
  while (matches.length < limit) {
    const found = regex.exec(text);
    if (!found) break;
    if (found[0].length === 0) {
      regex.lastIndex +=
        (text.codePointAt(regex.lastIndex) ?? 0) > 0xffff ? 2 : 1;
      continue;
    }
    const startColumn = columnAt[found.index];
    const last = columnAt[found.index + found[0].length - 1];
    // A match ending on a wide character covers its second cell too.
    const endColumn = cells[last + 1] === "" ? last + 2 : last + 1;
    matches.push({ line, startColumn, endColumn });
  }
  return matches;
}
