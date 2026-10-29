import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getSearchQuery,
  search,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { SearchCountHub, searchCountHub } from "../lib/searchCount";
import { EditorRegexView } from "./regexView";
import { regexQuery, queryEffects, interceptRegex } from "./regexState";
import type { RegexMatch, RegexSpec } from "./regexTypes";
const spec: RegexSpec = {
  search: "x",
  replace: "Y",
  caseSensitive: false,
  literal: false,
  wholeWord: false,
  regexp: true,
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
  const hub = new SearchCountHub();
  const stop = hub.subscribe(() => {});
  const readonly = new Compartment();
  const requests: {
    resolve: (m: RegexMatch[]) => void;
    reject: (e: Error) => void;
    cancel: ReturnType<typeof vi.fn>;
  }[] = [];
  const start = vi.fn(() => {
    let resolve = (_m: RegexMatch[]) => {},
      reject = (_e: Error) => {};
    const result = new Promise<RegexMatch[]>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const cancel = vi.fn();
    requests.push({ resolve, reject, cancel });
    return { result, cancel };
  });
  const view = {
    inView: true,
    visibleRanges: [{ from: 0, to: 3 }],
    state: EditorState.create({
      doc: "x x",
      extensions: [
        search(),
        regexQuery,
        interceptRegex,
        searchCountHub.of(hub),
        readonly.of(EditorState.readOnly.of(false)),
      ],
    }),
    dispatch(input: TransactionSpec) {
      const tr = view.state.update(input);
      const before = view.state;
      view.state = tr.state;
      engine.update({
        state: tr.state,
        startState: before,
        transactions: [tr],
        docChanged: tr.docChanged,
        selectionSet: !!tr.selection,
        viewportChanged: false,
      } as unknown as ViewUpdate);
    },
  };
  const engine = new EditorRegexView(view as unknown as EditorView, start);
  view.dispatch({ effects: queryEffects(spec) });
  const cleanup = () => {
    engine.destroy();
    stop();
  };
  return { view, engine, start, requests, hub, cleanup, readonly, stop };
}
it("intercepts external regex effects before any native CodeMirror highlighting or cursor can evaluate them", () => {
  const f = fixture();
  try {
    f.view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({ search: "(a+)+$", regexp: true }),
      ),
    });
    expect(getSearchQuery(f.view.state).search).toBe("");
    expect(getSearchQuery(f.view.state).regexp).toBe(false);
    expect(f.view.state.field(regexQuery)?.search).toBe("(a+)+$");
  } finally {
    f.cleanup();
  }
});
it("applies replacement only from a complete result for the current document", async () => {
  const f = fixture();
  try {
    f.engine.run("replaceAll");
    await vi.advanceTimersByTimeAsync(100);
    f.requests[0].resolve([
      { from: 0, to: 1, insert: "Y" },
      { from: 2, to: 3, insert: "Y" },
    ]);
    await Promise.resolve();
    expect(f.view.state.doc.toString()).toBe("Y Y");
  } finally {
    f.cleanup();
  }
});
it.each([
  "edit",
  "query",
  "selection",
  "readonly",
  "close",
  "hide",
  "destroy",
] as const)("prevents a delayed Replace All after %s", async (change) => {
  const f = fixture();
  try {
    f.engine.run("replaceAll");
    await vi.advanceTimersByTimeAsync(100);
    if (change === "edit")
      f.view.dispatch({ changes: { from: 0, insert: "new " } });
    if (change === "query")
      f.view.dispatch({ effects: queryEffects({ ...spec, search: "new" }) });
    if (change === "selection")
      f.view.dispatch({ selection: EditorSelection.single(2) });
    if (change === "readonly")
      f.view.dispatch({
        effects: f.readonly.reconfigure(EditorState.readOnly.of(true)),
      });
    if (change === "close") f.stop();
    if (change === "hide") {
      f.view.inView = false;
      f.view.dispatch({});
    }
    if (change === "destroy") f.engine.destroy();
    const before = f.view.state.doc;
    f.requests[0].resolve([{ from: 0, to: 1, insert: "BAD" }]);
    await Promise.resolve();
    expect(f.view.state.doc).toBe(before);
    if (["edit", "query", "close", "hide", "destroy"].includes(change))
      expect(f.requests[0].cancel).toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});
it("shows failure, clears matches and retries only explicitly", async () => {
  const f = fixture();
  try {
    await vi.advanceTimersByTimeAsync(100);
    f.requests[0].reject(new Error("timed out"));
    await Promise.resolve();
    expect(f.hub.get()).toMatchObject({
      error: "timed out",
      total: 0,
      pending: false,
    });
    f.view.dispatch({ selection: { anchor: 2 } });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.start).toHaveBeenCalledOnce();
    f.engine.retry();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.start).toHaveBeenCalledTimes(2);
    f.requests[1].resolve([{ from: 0, to: 1, insert: "Y" }]);
    await Promise.resolve();
    expect(f.hub.get()).toMatchObject({ total: 1, pending: false });
    expect(f.engine.decorations.size).toBe(1);
  } finally {
    f.cleanup();
  }
});

it("keeps the regex toggle on for an empty query without starting a worker", async () => {
  const f = fixture();
  try {
    f.view.dispatch({ effects: queryEffects({ ...spec, search: "" }) });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.view.state.field(regexQuery)?.regexp).toBe(true);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.hub.get()).toBeNull();
  } finally {
    f.cleanup();
  }
});
