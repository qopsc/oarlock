import {
  openSearchPanel,
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  searchKeymap,
  searchPanelOpen,
  selectMatches,
} from "@codemirror/search";
import {
  CharCategory,
  EditorSelection,
  type EditorState,
  findClusterBreak,
  Prec,
  StateEffect,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
  type Command,
} from "@codemirror/view";
import { SearchCountHub, searchCountHub } from "../lib/searchCount";
import { startRegex, type RegexTask } from "./regexClient";
import { regexQuery, queryEffects } from "./regexState";
import { MAX_TEXT_UNITS, type RegexMatch, type RegexSpec } from "./regexTypes";

const repaint = StateEffect.define<null>();
type Action = "next" | "previous" | "all" | "replace" | "replaceAll";
type Pending = { action: Action; selection: EditorSelection };

/** Match boundaries use the actual document language's categorizer, not a worker guess. */
export function wholeWordMatches(
  state: EditorState,
  matches: RegexMatch[],
): RegexMatch[] {
  const categorize = state.charCategorizer(state.selection.main.head);
  const word = (s: string) => categorize(s) === CharCategory.Word;
  return matches.filter(({ from, to }) => {
    if (from === to) return true;
    const start = Math.max(0, from - 32),
      end = Math.min(state.doc.length, to + 32);
    const text = state.doc.sliceString(start, end),
      a = from - start,
      b = to - start;
    const before = (i: number) =>
      text.slice(findClusterBreak(text, i, false), i);
    const after = (i: number) => text.slice(i, findClusterBreak(text, i));
    return (
      (!word(before(a)) || !word(after(a))) &&
      (!word(before(b)) || !word(after(b)))
    );
  });
}

export class EditorRegexView {
  decorations: DecorationSet = Decoration.none;
  private readonly hub: SearchCountHub;
  private stopWatching: () => void;
  private task: RegexTask | null = null;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private spec: RegexSpec | null = null;
  private doc: Text | null = null;
  private matches: RegexMatch[] | null = null;
  private error: string | null = null;
  private pending: Pending | null = null;
  private generation = 0;
  private destroyed = false;
  constructor(
    private view: EditorView,
    private readonly start = startRegex,
  ) {
    this.hub = view.state.facet(searchCountHub) ?? new SearchCountHub();
    this.stopWatching = this.hub.watchDemand(() => {
      if (!this.wanted()) {
        this.cancel();
        this.pending = null;
        this.matches = null;
      } else this.schedule(0);
    });
    this.schedule();
  }
  update(update: ViewUpdate) {
    const spec = this.view.state.field(regexQuery);
    if (
      spec !== this.spec ||
      this.view.state.doc !== this.doc ||
      !this.wanted()
    ) {
      this.cancel();
      this.spec = spec;
      this.doc = this.view.state.doc;
      this.matches = null;
      this.error = null;
      this.pending = null;
      this.decorations = Decoration.none;
      if (spec) this.publish();
      if (this.wanted()) this.schedule();
    } else if (
      update.selectionSet ||
      update.viewportChanged ||
      update.transactions.some((t) => t.effects.some((e) => e.is(repaint)))
    ) {
      if (update.selectionSet) this.pending = null;
      this.decorate();
      this.publish();
    }
    if (this.wanted() && !this.task && !this.matches && !this.error)
      this.schedule();
  }
  private wanted() {
    return (
      !this.destroyed &&
      this.view.inView &&
      !!this.view.state.field(regexQuery)?.search &&
      (searchPanelOpen(this.view.state) || this.hub.wanted)
    );
  }
  private schedule(delay = 100) {
    if (this.destroyed || (this.scheduled !== null && delay > 0)) return;
    if (this.scheduled !== null) clearTimeout(this.scheduled);
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      this.scan();
    }, delay);
  }
  private scan() {
    if (!this.wanted() || this.task || this.matches || this.error) return;
    const state = this.view.state;
    const spec = state.field(regexQuery);
    if (!spec) return;
    this.spec = spec;
    this.doc = state.doc;
    const generation = ++this.generation;
    try {
      if (state.doc.length > MAX_TEXT_UNITS)
        throw new Error(
          "Document is too large for regex search (16 MiB maximum). Use literal search.",
        );
      const task = this.start({ text: state.doc.toString(), spec });
      this.task = task;
      this.publish();
      void task.result.then(
        (matches) => {
          if (!this.current(generation, state, spec)) return;
          this.task = null;
          this.matches = spec.wholeWord
            ? wholeWordMatches(state, matches)
            : matches;
          this.view.dispatch({ effects: repaint.of(null) });
          const pending = this.pending;
          this.pending = null;
          if (pending?.selection.eq(this.view.state.selection))
            this.apply(pending.action);
        },
        (error) => {
          if (!this.current(generation, state, spec)) return;
          this.task = null;
          this.pending = null;
          this.error =
            error instanceof Error ? error.message : "Regex search failed.";
          this.view.dispatch({ effects: repaint.of(null) });
        },
      );
    } catch (error) {
      this.error =
        error instanceof Error ? error.message : "Regex search failed.";
      this.pending = null;
      this.publish();
    }
  }
  private current(generation: number, state: EditorState, spec: RegexSpec) {
    return (
      !this.destroyed &&
      generation === this.generation &&
      this.view.state.doc === state.doc &&
      this.view.state.field(regexQuery) === spec &&
      this.wanted()
    );
  }
  run(action: Action) {
    if (!this.view.state.field(regexQuery)) return false;
    if (!this.view.inView) return true;
    if (!this.wanted()) safeOpenSearchPanel(this.view);
    if (this.error) {
      this.error = null;
      this.matches = null;
    }
    this.pending = { action, selection: this.view.state.selection };
    if (this.matches) {
      this.pending = null;
      this.apply(action);
    } else this.schedule(0);
    return true;
  }
  retry() {
    if (!this.view.state.field(regexQuery)) return;
    this.cancel();
    this.error = null;
    this.matches = null;
    this.pending = null;
    this.publish();
    this.schedule(0);
  }
  private apply(action: Action) {
    const { state } = this.view;
    const matches = this.matches;
    if (
      !matches?.length ||
      state.doc !== this.doc ||
      state.field(regexQuery) !== this.spec
    )
      return;
    const { from, to } = state.selection.main;
    const select = (m: RegexMatch) =>
      this.view.dispatch({
        selection: EditorSelection.single(m.from, m.to),
        effects: EditorView.scrollIntoView(m.from),
        userEvent: "select.search",
      });
    if (action === "replaceAll" || action === "replace") {
      if (state.readOnly || !state.facet(EditorView.editable)) return;
      if (action === "replaceAll") {
        this.view.dispatch({
          changes: matches.map(({ from, to, insert }) => ({
            from,
            to,
            insert,
          })),
          userEvent: "input.replace.all",
        });
      } else {
        const index = matches.findIndex((m) => m.from === from && m.to === to);
        if (index < 0) {
          select(matches.find((m) => m.from >= from) ?? matches[0]);
          return;
        }
        const match = matches[index];
        const changes = state.changes({
          from: match.from,
          to: match.to,
          insert: match.insert,
        });
        const next = matches[(index + 1) % matches.length];
        this.view.dispatch({
          changes,
          selection: EditorSelection.single(next.from, next.to).map(changes),
          scrollIntoView: true,
          userEvent: "input.replace",
        });
      }
    } else if (action === "all") {
      if (matches.length > 1000) {
        this.error = "Too many selections (1,000 maximum). Refine the pattern.";
        this.publish();
        return;
      }
      this.view.dispatch({
        selection: EditorSelection.create(
          matches.map((m) => EditorSelection.range(m.from, m.to)),
        ),
        userEvent: "select.search.matches",
      });
    } else if (action === "next") {
      select(
        matches.find(
          (m) => m.from >= to && !(m.from === from && m.to === to),
        ) ?? matches[0],
      );
    } else {
      let previous: RegexMatch | undefined;
      for (const match of matches)
        if (match.to <= from && !(match.from === from && match.to === to))
          previous = match;
      select(previous ?? matches[matches.length - 1]);
    }
  }
  private decorate() {
    if (!this.matches || this.error) {
      this.decorations = Decoration.none;
      return;
    }
    const selection = this.view.state.selection.main;
    this.decorations = Decoration.set(
      this.matches
        .filter(
          (m) =>
            m.from < m.to &&
            this.view.visibleRanges.some((r) => m.to > r.from && m.from < r.to),
        )
        .map((m) =>
          Decoration.mark({
            class:
              m.from === selection.from && m.to === selection.to
                ? "cm-searchMatch cm-searchMatch-selected"
                : "cm-searchMatch",
          }).range(m.from, m.to),
        ),
      true,
    );
  }
  private publish() {
    if (!this.view.state.field(regexQuery)) return;
    if (!this.view.state.field(regexQuery)?.search) {
      this.hub.publish(null);
      return;
    }
    const { from, to } = this.view.state.selection.main;
    const current =
      this.matches?.findIndex((m) => m.from === from && m.to === to) ?? -1;
    this.hub.publish({
      current: current + 1,
      total: this.error ? 0 : (this.matches?.length ?? 0),
      capped: false,
      pending: !this.error && this.matches === null,
      ...(this.error ? { error: this.error } : {}),
    });
  }
  private cancel() {
    this.generation++;
    this.task?.cancel();
    this.task = null;
    if (this.scheduled !== null) clearTimeout(this.scheduled);
    this.scheduled = null;
  }
  destroy() {
    this.destroyed = true;
    this.cancel();
    this.stopWatching();
    this.matches = null;
    this.pending = null;
  }
}
export const editorRegex = ViewPlugin.define(
  (view) => new EditorRegexView(view),
  { decorations: (value) => value.decorations },
);
function command(action: Action, fallback: Command): Command {
  return (view) =>
    view.state.field(regexQuery, false)
      ? (view.plugin(editorRegex)?.run(action) ?? true)
      : fallback(view);
}
export function safeOpenSearchPanel(view: EditorView): boolean {
  const spec = view.state.field(regexQuery, false);
  const opened = openSearchPanel(view);
  if (spec) view.dispatch({ effects: queryEffects(spec) });
  return opened;
}
export const safeFindNext = command("next", findNext);
export const safeFindPrevious = command("previous", findPrevious);
export const safeReplaceNext = command("replace", replaceNext);
export const safeReplaceAll = command("replaceAll", replaceAll);
export const safeSelectMatches = command("all", selectMatches);
const replacements = new Map<Command, Command>([
  [openSearchPanel, safeOpenSearchPanel],
  [findNext, safeFindNext],
  [findPrevious, safeFindPrevious],
  [replaceNext, safeReplaceNext],
  [replaceAll, safeReplaceAll],
  [selectMatches, safeSelectMatches],
]);
// Claim regex actions even while pending, so lower-priority keymaps cannot fall through.
export const safeSearchKeymap = Prec.highest(
  keymap.of(
    searchKeymap.map((binding) => ({
      ...binding,
      run: binding.run && (replacements.get(binding.run) ?? binding.run),
      shift:
        binding.shift && (replacements.get(binding.shift) ?? binding.shift),
    })),
  ),
);
