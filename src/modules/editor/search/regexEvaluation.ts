// Imported only by the worker and regression probes, never the UI bundle.
import { SearchQuery } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  MAX_MATCHES,
  MAX_TEXT_UNITS,
  validateInput,
  type RegexInput,
  type RegexMatch,
} from "./regexTypes";

/** Preserve CodeMirror's regex, multiline, zero-width and replacement semantics. */
export function evaluateRegex(input: RegexInput): RegexMatch[] {
  validateInput(input);
  const query = new SearchQuery({ ...input.spec, wholeWord: false });
  if (!query.valid) throw new Error("Invalid regular expression.");
  const state = EditorState.create({ doc: input.text });
  const cursor = query.getCursor(state);
  const replacement = input.spec.literal
    ? input.spec.replace
    : input.spec.replace.replace(/\\([nrt\\])/g, (_, ch) =>
        ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : "\\",
      );
  const matches: RegexMatch[] = [];
  let units = 0;
  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    if (matches.length === MAX_MATCHES)
      throw new Error(
        "Too many regex matches (10,000 maximum). Refine the pattern.",
      );
    const result = item.value as {
      from: number;
      to: number;
      match: RegExpExecArray;
    };
    const insert = replacement.replace(/\$([$&]|\d+)/g, (m, i: string) => {
      if (i === "&") return result.match[0];
      if (i === "$") return "$";
      for (let l = i.length; l > 0; l--) {
        const n = +i.slice(0, l);
        if (n > 0 && n < result.match.length)
          return result.match[n] + i.slice(l);
      }
      return m;
    });
    units += insert.length;
    if (units > MAX_TEXT_UNITS)
      throw new Error(
        "Regex replacement output is too large (16 MiB maximum).",
      );
    matches.push({ from: result.from, to: result.to, insert });
  }
  return matches;
}
