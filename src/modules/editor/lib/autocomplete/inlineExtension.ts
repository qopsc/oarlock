import type { CompletionRequest } from "./prompt";
import {
  type EditorState,
  type Extension,
  Prec,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import {
  Decoration,
  EditorView,
  keymap,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { hasCompletionProvider } from "./configuration";
import { normalizeIndent } from "./normalizeIndent";
import { type CompletionDeps, requestCompletion } from "./provider";

type AutocompletePrefs = CompletionDeps & {
  enabled: boolean;
  trigger: "auto" | "manual";
};

export type AutocompleteContext = {
  getPrefs: () => AutocompletePrefs;
  getPath: () => string | null;
  getLanguage: () => string | null;
  getDocument: () => CompletionRequest["document"];
};

type Suggestion = {
  from: number;
  text: string;
};

const setSuggestion = StateEffect.define<Suggestion | null>();

const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSuggestion)) return e.value;
    }
    if (!value) return value;
    if (tr.docChanged) {
      return consumeIfTypedAhead(value, tr);
    }
    if (tr.selection) return null;
    return value;
  },
});

function consumeIfTypedAhead(
  current: Suggestion,
  tr: Transaction,
): Suggestion | null {
  let consumed: string | null = null;
  let originDelta = 0;
  let abort = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (abort) return;
    const ins = inserted.toString();
    if (fromA !== toA || fromA !== current.from || !ins) {
      abort = true;
      return;
    }
    if (current.text.startsWith(ins)) {
      consumed = ins;
      originDelta = ins.length;
    } else {
      abort = true;
    }
  });
  if (abort || !consumed) return null;
  const remaining = current.text.slice((consumed as string).length);
  if (!remaining) return null;
  return { from: current.from + originDelta, text: remaining };
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ai-ghost";
    span.textContent = this.text;
    return span;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

const ghostTheme = EditorView.theme({
  ".cm-ai-ghost": {
    opacity: "0.45",
    fontStyle: "italic",
    pointerEvents: "none",
  },
  ".cm-ai-ghost-block": {
    whiteSpace: "pre",
    overflowX: "hidden",
  },
});

class GhostBlockWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: GhostBlockWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-ai-ghost cm-ai-ghost-block";
    div.textContent = this.text;
    return div;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

// First line renders inline at the cursor; continuation lines render as a
// block widget below the line so the rest of the document never gets
// displaced mid-line by an inline <br> stack. A line-suffix after the
// cursor (only closing punctuation, enforced by capToLineSuffix) is hidden
// and re-appended after the block, previewing exactly what accepting
// produces.
const ghostDecorations = EditorView.decorations.compute(
  [suggestionField],
  (state) => {
    const sug = state.field(suggestionField);
    if (!sug) return Decoration.none;
    const nl = sug.text.indexOf("\n");
    const firstLine = nl === -1 ? sug.text : sug.text.slice(0, nl);
    const ranges = [];

    if (nl === -1) {
      if (firstLine) {
        ranges.push(
          Decoration.widget({
            widget: new GhostWidget(firstLine),
            side: 1,
          }).range(sug.from),
        );
      }
      return Decoration.set(ranges, true);
    }

    const line = state.doc.lineAt(sug.from);
    const lineSuffix = state.doc.sliceString(sug.from, line.to);
    let rest = sug.text.slice(nl + 1);
    if (lineSuffix.trim()) {
      ranges.push(
        Decoration.replace(
          firstLine ? { widget: new GhostWidget(firstLine) } : {},
        ).range(sug.from, line.to),
      );
      rest += lineSuffix;
    } else if (firstLine) {
      ranges.push(
        Decoration.widget({
          widget: new GhostWidget(firstLine),
          side: 1,
        }).range(sug.from),
      );
    }
    if (rest) {
      ranges.push(
        Decoration.widget({
          widget: new GhostBlockWidget(rest),
          side: 1,
          block: true,
        }).range(line.to),
      );
    }
    return Decoration.set(ranges, true);
  },
);

const DEBOUNCE_MS = 350;
const CHAIN_DELAY_MS = 80;
const MIN_PREFIX_CHARS = 2;
const MAX_LINES = 6;
const CACHE_SIZE = 32;
const PREFIX_WINDOW = 4000;
const SUFFIX_WINDOW = 2000;

class LRU {
  private map = new Map<string, string>();
  private chars = 0;
  constructor(private readonly cap: number) {}
  get(k: string): string | undefined {
    const v = this.map.get(k);
    if (v === undefined) return undefined;
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k: string, v: string) {
    const previous = this.map.get(k);
    if (previous !== undefined) {
      this.chars -= k.length + previous.length;
      this.map.delete(k);
    }
    this.map.set(k, v);
    this.chars += k.length + v.length;
    // Full prompt identities must not grow the old compact cache unchecked.
    // Keep at most 64 KiB of estimated UTF-16 text, including JSON escaping.
    while (this.map.size > this.cap || this.chars > 32 * 1024) {
      const first = this.map.entries().next().value;
      if (!first) break;
      this.chars -= first[0].length + first[1].length;
      this.map.delete(first[0]);
    }
  }
  clear() {
    this.map.clear();
    this.chars = 0;
  }
}

function suggestionKey(prefix: string, suffix: string): string {
  // Use the complete (already bounded) model context, without delimiter collisions.
  return JSON.stringify([prefix, suffix]);
}

function contextKey(ctx: AutocompleteContext, state: EditorState): string {
  const p = ctx.getPrefs();
  return JSON.stringify([
    p.enabled,
    p.trigger,
    p.provider,
    p.modelId,
    p.apiKey,
    p.credentialStatus,
    p.lmstudioBaseURL,
    p.mlxBaseURL,
    p.ollamaBaseURL,
    p.openaiCompatibleBaseURL,
    ctx.getPath(),
    ctx.getDocument(),
    ctx.getLanguage(),
    state.facet(indentUnit),
  ]);
}

function shouldTrigger(
  state: EditorState,
  prefs: AutocompletePrefs,
  isManual: boolean,
): boolean {
  if (!prefs.enabled) return false;
  if (!hasCompletionProvider(prefs)) return false;
  // Requests and suggestions describe one insertion point. Accepting one
  // while multiple cursors exist would silently discard the other cursors.
  if (state.selection.ranges.length !== 1) return false;
  const sel = state.selection.main;
  if (sel.from !== sel.to) return false;
  if (isManual) return true;

  const cursor = sel.from;
  const doc = state.doc;
  if (doc.length === 0) return false;

  // Skip if cursor is in the middle of an identifier — typing ghost mid-word
  // is the most disruptive failure mode.
  if (cursor < doc.length) {
    const next = doc.sliceString(cursor, cursor + 1);
    if (next && /[\w$]/.test(next)) return false;
  }

  // Require some non-whitespace context within the recent prefix window.
  const recent = doc.sliceString(Math.max(0, cursor - 200), cursor);
  if (recent.replace(/\s/g, "").length < MIN_PREFIX_CHARS) return false;

  return true;
}

const drivers = new WeakMap<EditorView, CompletionDriver>();

class CompletionDriver implements PluginValue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private inflightKey: string | null = null;
  private cache = new LRU(CACHE_SIZE);
  private cacheContext: string | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly ctx: AutocompleteContext,
  ) {
    drivers.set(view, this);
    this.cacheContext = contextKey(ctx, view.state);
  }

  refreshConfiguration(force: boolean) {
    const context = contextKey(this.ctx, this.view.state);
    if (!force && this.cacheContext === context) return;
    this.cancelTimer();
    this.cancelInFlight();
    this.cache.clear();
    this.cacheContext = context;
    this.clearGhost();
  }

  update(u: ViewUpdate) {
    if (!u.docChanged && !u.selectionSet) return;
    // Formatting, reload and programmatic edits invalidate requests too. Abort
    // immediately, rather than letting an old response win the debounce window.
    this.cancelTimer();
    this.cancelInFlight();

    let typed = false;
    let chained = false;
    let isDelete = false;
    let isUndo = false;
    for (const tr of u.transactions) {
      const ev = tr.annotation(Transaction.userEvent);
      if (!ev) continue;
      if (ev.startsWith("input.complete.ai")) chained = true;
      else if (ev.startsWith("input")) typed = true;
      else if (ev.startsWith("delete")) isDelete = true;
      else if (ev === "undo" || ev === "redo") isUndo = true;
    }

    if (isDelete || isUndo) return;

    const manual = this.ctx.getPrefs().trigger === "manual";

    if (chained && !manual) {
      // After accept/accept-word, fire again with a short delay so the next
      // suggestion is ready as soon as the user looks up.
      this.schedule(false, CHAIN_DELAY_MS);
      return;
    }

    if (u.docChanged && typed && !manual) {
      this.schedule(false);
      return;
    }
  }

  manualTrigger() {
    this.schedule(true);
  }

  private schedule(isManual: boolean, delayOverride?: number) {
    this.cancelTimer();
    const delay = delayOverride ?? (isManual ? 0 : DEBOUNCE_MS);
    this.timer = setTimeout(() => void this.fire(isManual), delay);
  }

  private cancelTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private cancelInFlight() {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
      this.inflightKey = null;
    }
  }

  private clearGhost() {
    if (this.view.state.field(suggestionField)) {
      this.view.dispatch({ effects: setSuggestion.of(null) });
    }
  }

  destroy() {
    this.cancelInFlight();
    this.cancelTimer();
    this.cache.clear();
    this.cacheContext = null;
    drivers.delete(this.view);
  }

  private async fire(isManual: boolean) {
    this.refreshConfiguration(false);
    const prefs = this.ctx.getPrefs();
    const state = this.view.state;
    if (!shouldTrigger(state, prefs, isManual)) return;

    const cursor = state.selection.main.from;
    const doc = state.doc;
    const prefix = doc.sliceString(Math.max(0, cursor - PREFIX_WINDOW), cursor);
    const suffix = doc.sliceString(
      cursor,
      Math.min(doc.length, cursor + SUFFIX_WINDOW),
    );

    const lang = this.ctx.getLanguage();
    const context = contextKey(this.ctx, state);
    const key = suggestionKey(prefix, suffix);

    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.applyResult(cached, cursor);
      return;
    }

    if (this.inflightKey === key) return;
    this.cancelInFlight();
    const controller = new AbortController();
    this.controller = controller;
    this.inflightKey = key;
    const signal = controller.signal;

    let raw = "";
    try {
      raw = await requestCompletion(
        {
          prefix,
          suffix,
          filename: this.ctx.getPath(),
          document: this.ctx.getDocument(),
          language: lang,
          indentUnit: state.facet(indentUnit) || null,
        },
        prefs,
        signal,
      );
    } catch (err) {
      if (signal.aborted) return;
      if (this.controller === controller) {
        this.controller = null;
        this.inflightKey = null;
      }
      return;
    }
    if (signal.aborted) return;
    if (this.controller === controller) {
      this.controller = null;
      this.inflightKey = null;
    }
    if (
      this.view.state.doc !== doc ||
      contextKey(this.ctx, this.view.state) !== context
    )
      return;

    const cursorLine = doc.lineAt(cursor);
    const lineSoFar = doc.sliceString(cursorLine.from, cursor);
    const lineSuffix = doc.sliceString(cursor, cursorLine.to);
    const unit = state.facet(indentUnit) || "  ";
    const trimmed = reindentClosers(
      normalizeIndent(
        capToLineSuffix(trimSuggestion(raw, prefix, suffix), lineSuffix),
        unit,
      ),
      unit,
      lineSoFar,
    );
    // Only cache non-empty: empty often comes from a flaky reasoning-only
    // response, not from "no completion exists here." Letting it retry next
    // time is cheaper than persistently showing nothing.
    if (trimmed) this.cache.set(key, trimmed);
    this.applyResult(trimmed, cursor);
  }

  private applyResult(text: string, cursor: number) {
    if (!text) {
      this.clearGhost();
      return;
    }
    const sel = this.view.state.selection.main;
    if (sel.from !== cursor || sel.to !== cursor) return;
    this.view.dispatch({
      effects: setSuggestion.of({ from: cursor, text }),
    });
  }
}

// A suggestion that already exists verbatim (modulo whitespace) in the
// recent prefix is a model echo, the worst failure mode: accepting it
// duplicates code.
function isEcho(t: string, prefix: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const sug = norm(t);
  if (sug.length < 24) return false;
  return norm(prefix.slice(-2400)).includes(sug);
}

export function trimSuggestion(
  raw: string,
  prefix: string,
  suffix: string,
): string {
  if (!raw) return "";
  let t = raw;

  // Drop wrapping markdown fences if the model added them.
  const fence = t.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
  if (fence) t = fence[1];
  t = t.replace(/^<\|cursor\|>/, "");

  // Strip prefix-tail overlap: if PREFIX ends with a partial token "te" and
  // the model returned "test", drop the leading "te" so the ghost shows "st".
  const tailMatch = prefix.match(/[\w$]+$/);
  if (tailMatch) {
    const tail = tailMatch[0];
    for (let n = Math.min(tail.length, t.length); n > 0; n--) {
      if (t.slice(0, n) === tail.slice(tail.length - n)) {
        t = t.slice(n);
        break;
      }
    }
  }

  // Cap to a reasonable line count.
  const lines = t.split("\n");
  if (lines.length > MAX_LINES) t = lines.slice(0, MAX_LINES).join("\n");

  // Drop trailing overlap with suffix (model sometimes echoes what's ahead).
  const maxOverlap = Math.min(t.length, suffix.length);
  for (let n = maxOverlap; n > 0; n--) {
    if (t.slice(t.length - n) === suffix.slice(0, n)) {
      t = t.slice(0, t.length - n);
      break;
    }
  }

  // Strip leading indent that's already typed on the current line.
  const lastNl = prefix.lastIndexOf("\n");
  const lineSoFar = prefix.slice(lastNl + 1);
  if (
    lineSoFar.length > 0 &&
    /^\s+$/.test(lineSoFar) &&
    t.startsWith(lineSoFar)
  ) {
    t = t.slice(lineSoFar.length);
  }

  // If suggestion is just a duplicate of what's already typed on the line, skip.
  if (lineSoFar && t.trimStart() === lineSoFar.trimStart()) return "";

  t = t.replace(/\s+$/, "");

  if (isEcho(t, prefix)) return "";

  // If PREFIX's last line ends with an opening delimiter (`{`, `[`, `(`, `=>`)
  // and the suggestion is a body (multi-line OR starts with indent), prepend
  // a newline so the body doesn't land on the same line as the brace.
  if (
    t &&
    !t.startsWith("\n") &&
    /(?:[{[(]|=>)\s*$/.test(lineSoFar) &&
    (t.includes("\n") || /^\s/.test(t))
  ) {
    t = "\n" + t;
  }

  // Nothing legitimately continues a line after `;`: multi-line suggestions
  // and closing brackets always start on the next line.
  if (
    t &&
    !t.startsWith("\n") &&
    /;\s*$/.test(lineSoFar) &&
    (t.includes("\n") || /^[}\])]/.test(t))
  ) {
    t = "\n" + t;
  }

  return t;
}

const ONLY_CLOSERS_RE = /^[\s)\]};,]*$/;

// Mid-line completions (cursor inside `useState(|)`) get multi-line ghosts
// only when the rest of the line is closing punctuation; anything else in
// the line-suffix means the model is guessing across real code.
export function capToLineSuffix(t: string, lineSuffix: string): string {
  if (!t.includes("\n") || ONLY_CLOSERS_RE.test(lineSuffix)) return t;
  return t.slice(0, t.indexOf("\n")).replace(/\s+$/, "");
}

const CLOSER_LINE_RE = /^[ \t]*([}\])]+[;,]?)\s*$/;
const OPENER_END_RE = /[{[(]\s*$/;

// Models routinely mis-indent closer-only lines (a `}` floating at the
// depth of the block body). Their correct indent is derivable: same as the
// previous line when it opens a block, one unit shallower otherwise. The
// first suggestion line continues the cursor line, so that line anchors.
export function reindentClosers(
  t: string,
  unit: string,
  lineSoFar: string,
): string {
  if (!t.includes("\n")) return t;
  const lines = t.split("\n");
  let prevIndent = /^[ \t]*/.exec(lineSoFar)?.[0] ?? "";
  let prevText = lineSoFar + lines[0];
  for (let i = 1; i < lines.length; i++) {
    const closer = CLOSER_LINE_RE.exec(lines[i]);
    if (closer) {
      const indent = OPENER_END_RE.test(prevText)
        ? prevIndent
        : prevIndent.slice(0, Math.max(0, prevIndent.length - unit.length));
      lines[i] = indent + closer[1];
    }
    if (lines[i].trim().length > 0) {
      prevIndent = /^[ \t]*/.exec(lines[i])?.[0] ?? "";
      prevText = lines[i];
    }
  }
  return lines.join("\n");
}

function acceptSuggestion(view: EditorView): boolean {
  drivers.get(view)?.refreshConfiguration(false);
  const sug = view.state.field(suggestionField, false);
  if (!sug) return false;
  view.dispatch({
    changes: { from: sug.from, to: sug.from, insert: sug.text },
    selection: { anchor: sug.from + sug.text.length },
    effects: setSuggestion.of(null),
    userEvent: "input.complete.ai",
  });
  return true;
}

function acceptWord(view: EditorView): boolean {
  drivers.get(view)?.refreshConfiguration(false);
  const sug = view.state.field(suggestionField, false);
  if (!sug) return false;
  // Take the next contiguous chunk: leading whitespace + one word OR one
  // punctuation run. Falls back to whole-suggestion if nothing matches.
  const m =
    sug.text.match(/^\s*[\w$]+/) ??
    sug.text.match(/^\s*[^\w\s$]+/) ??
    sug.text.match(/^\s+/);
  if (!m) return acceptSuggestion(view);
  const chunk = m[0];
  const remaining = sug.text.slice(chunk.length);
  view.dispatch({
    changes: { from: sug.from, to: sug.from, insert: chunk },
    selection: { anchor: sug.from + chunk.length },
    effects: setSuggestion.of(
      remaining ? { from: sug.from + chunk.length, text: remaining } : null,
    ),
    userEvent: "input.complete.ai",
  });
  return true;
}

function dismissSuggestion(view: EditorView): boolean {
  const sug = view.state.field(suggestionField, false);
  if (!sug) return false;
  view.dispatch({ effects: setSuggestion.of(null) });
  return true;
}

/** Manually request a ghost suggestion; bound via the app shortcut registry. */
export function triggerInlineCompletion(view: EditorView): boolean {
  const driver = drivers.get(view);
  if (!driver) return false;
  driver.manualTrigger();
  return true;
}

/** Called outside CodeMirror updates by settings and credential notifications. */
export function refreshInlineCompletion(view: EditorView, force = false): void {
  drivers.get(view)?.refreshConfiguration(force);
}

export function inlineCompletion(ctx: AutocompleteContext): Extension {
  const plugin = ViewPlugin.define((view) => new CompletionDriver(view, ctx));

  return [
    suggestionField,
    ghostDecorations,
    ghostTheme,
    plugin,
    Prec.highest(
      keymap.of([
        { key: "Tab", run: acceptSuggestion },
        { key: "Escape", run: dismissSuggestion },
        { key: "Mod-ArrowRight", run: acceptWord },
      ]),
    ),
  ];
}
