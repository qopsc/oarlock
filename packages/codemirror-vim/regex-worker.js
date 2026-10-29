// Worker-only. Never import this module into the UI bundle.
import { RegExpCursor } from "@codemirror/search";
import { Text } from "@codemirror/state";
import { checkResultBudget } from "./result-budget.js";
const MAX_TEXT = 8_388_608,
  MAX_MATCHES = 10_000;
let doc = Text.empty;
const bounded = checkResultBudget;
export function evaluate(request) {
  if (request.text !== undefined) {
    if (request.text.length > MAX_TEXT)
      throw Error("Vim regex document exceeds 16 MiB.");
    doc = Text.of(request.text.split("\n"));
  }
  if (request.changes)
    for (const changes of request.changes) {
      for (let i = changes.length - 1; i >= 0; i--) {
        const change = changes[i];
        doc = doc.replace(
          change.from,
          change.to,
          Text.of(change.insert.split("\n")),
        );
      }
    }
  if (doc.length > MAX_TEXT) throw Error("Vim regex document exceeds 16 MiB.");
  if (request.source.length > 4096)
    throw Error("Vim pattern exceeds 4,096 characters.");
  const query = new RegExp(request.source, request.flags);
  if (request.kind === "lines") {
    if (request.lines.length > 10000)
      throw Error("Vim regex range exceeds 10,000 lines.");
    if (request.lines.reduce((n, s) => n + s.length, 0) > MAX_TEXT)
      throw Error("Vim regex input exceeds 16 MiB.");
    return bounded(request.lines.map((line) => line.match(query)));
  }
  if (request.kind === "replace")
    return bounded(request.value.replace(query, request.replacement));
  // Keep the adapter's original range and backward chunk semantics, including
  // overlapping matches when a search starts inside a preceding match.
  const source = query.source.replace(
    /(\\.|{(?:\d+(?:,\d*)?|,\d+)})|[{}]/g,
    (a, b) => b || "\\" + a,
  );
  const cursor = (from, to = doc.length) =>
    new RegExpCursor(doc, source, { ignoreCase: query.ignoreCase }, from, to);
  if (request.kind === "highlight") {
    const matches = [];
    let search = cursor(0);
    while (!search.next().done) {
      if (matches.length === MAX_MATCHES)
        throw Error("Vim search exceeds 10,000 matches.");
      matches.push({ from: search.value.from, to: search.value.to });
    }
    return matches;
  }
  if (!request.back) {
    if (request.from > doc.length) return null;
    const result = cursor(request.from).next();
    return result.done ? null : bounded(result.value);
  }
  if (request.from < 0) return null;
  for (let size = 1; ; size++) {
    const start = Math.max(0, request.from - size * 10000);
    let search = cursor(start, request.from),
      range = null,
      count = 0;
    while (!search.next().done) {
      if (++count > MAX_MATCHES)
        throw Error("Vim search exceeds 10,000 matches.");
      range = search.value;
    }
    if (range && (start === 0 || range.from > start + 10))
      return bounded(range);
    if (start === 0) return null;
  }
}
if (typeof self !== "undefined")
  self.onmessage = ({ data }) => {
    try {
      self.postMessage({ value: evaluate(data) });
    } catch (error) {
      self.postMessage({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
