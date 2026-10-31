import type {
  GhosttySearchStatus,
  GhosttySearchViewportSpan,
  GhosttyTerminalModelApi,
} from "../GhosttyTerminalModel";

import {
  MAX_REGEX_MATCHES,
  REGEX_BATCH_CELLS,
  REGEX_BATCH_UNITS,
  REGEX_BATCH_LINES,
  REGEX_PATTERN_UNITS,
  REGEX_TOTAL_UNITS,
  REGEX_TOTAL_MS,
  type RegexMatch,
  type RegexBatch,
} from "./regexProtocol";
import { createRegexRunner, type RegexRunner } from "./regexWorkerClient";
export { MAX_REGEX_MATCHES } from "./regexProtocol";

/**
 * Regular-expression search over the whole buffer, in budgeted steps like
 * the core's literal search: `step()` scans some lines, `select()` moves to
 * the next or previous match and scrolls it into view, `viewportMatches()`
 * gives the highlights. Lines are searched one at a time (a match does not
 * span a wrap). Any content change restarts the scan.
 */
export class RegexTerminalSearch {
  private pattern = "";
  private error: string | undefined;
  private runner: RegexRunner | null = null;
  private pending = false;
  private disposed = false;
  private suspended = false;
  private revisionTimer: ReturnType<typeof setTimeout> | null = null;
  private scannedUnits = 0;
  private startedAt: number | null = null;
  private operation = 0;
  private matches: RegexMatch[] = [];
  private nextLine = 0;
  private totalLines = 0;
  private revision = -1;
  private selected = -1;
  private generation = 0;

  constructor(
    private readonly model: GhosttyTerminalModelApi,
    private readonly changed: () => void = () => {},
    private readonly makeRunner: () => RegexRunner = createRegexRunner,
  ) {}

  setQuery(pattern: string): GhosttySearchStatus {
    if (this.disposed) return this.status();
    this.pattern = pattern;
    this.error = undefined;
    this.restart();
    if (pattern.length > REGEX_PATTERN_UNITS)
      this.fail("Regex is too long. Use at most 4,096 characters.");
    return this.status();
  }

  clear(): void {
    this.cancel();
    this.pattern = "";
    this.error = undefined;
    this.matches = [];
    this.selected = -1;
    this.nextLine = this.totalLines = 0;
    this.generation++;
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
  }
  suspend(): void {
    this.suspended = true;
    this.cancel();
    this.revision = -1;
  }
  resume(): void {
    this.suspended = false;
  }
  failure(): string | undefined {
    return this.error;
  }
  restoreFailure(message: string): void {
    this.fail(message);
  }
  retry(): void {
    if (!this.disposed && this.error) this.setQuery(this.pattern);
  }

  /** Output bursts revoke in-flight work immediately, then wait for a quiet frame. */
  invalidate(): void {
    if (
      this.disposed ||
      this.suspended ||
      !this.pattern ||
      this.error ||
      this.model.revision() === this.revision
    )
      return;
    this.restart();
    this.revisionTimer = setTimeout(() => {
      this.revisionTimer = null;
      if (!this.disposed && !this.suspended) this.changed();
    }, 100);
  }

  /** Reads bounded rows on the UI thread; all regex compilation/execution is in the worker. */
  step(budget: number): GhosttySearchStatus {
    if (this.disposed || this.suspended || !this.pattern || this.error)
      return this.status();
    if (this.model.revision() !== this.revision) {
      this.invalidate();
      return this.status();
    }
    if (
      this.pending ||
      this.revisionTimer !== null ||
      this.nextLine >= this.totalLines
    )
      return this.status();
    if (this.startedAt === null) this.startedAt = performance.now();
    const remainingMs = REGEX_TOTAL_MS - (performance.now() - this.startedAt);
    if (remainingMs <= 0) {
      this.fail(
        "Regex search took too long. Refine the pattern or use literal search.",
      );
      return this.status();
    }
    const lines: string[][] = [];
    let units = 0;
    let cells = 0;
    const end = Math.min(
      this.totalLines,
      this.nextLine + Math.max(1, Math.min(budget, REGEX_BATCH_LINES)),
    );
    const readAt = performance.now();
    for (let line = this.nextLine; line < end; line++) {
      const row = [
        ...(this.model.readCellLines?.(line, line)?.[0] ??
          this.model.readCellLine?.(line) ??
          []),
      ];
      const length = row.reduce((sum, cell) => sum + cell.length, 0);
      if (length > REGEX_BATCH_UNITS || row.length > REGEX_BATCH_CELLS) {
        this.fail(
          "A terminal row is too large for regex search. Use literal search.",
        );
        return this.status();
      }
      if (
        units + length > REGEX_BATCH_UNITS ||
        cells + row.length > REGEX_BATCH_CELLS
      )
        break;
      lines.push(row);
      units += length;
      cells += row.length;
      if (performance.now() - readAt >= 4) break;
    }
    if (this.scannedUnits + units > REGEX_TOTAL_UNITS) {
      this.fail(
        "Terminal history is too large for regex search. Use literal search.",
      );
      return this.status();
    }
    this.scannedUnits += units;
    const operation = ++this.operation;
    const revision = this.revision;
    const firstLine = this.nextLine;
    this.pending = true;
    try {
      this.runner ??= this.makeRunner();
      const batch: RegexBatch = {
        pattern: this.pattern,
        lines,
        firstLine,
        limit: MAX_REGEX_MATCHES - this.matches.length,
      };
      void this.runner.run(batch, Math.min(1000, remainingMs)).then(
        (matches) => {
          if (operation !== this.operation || this.disposed || this.suspended)
            return;
          this.pending = false;
          if (this.model.revision() !== revision) {
            this.invalidate();
            return;
          }
          this.matches.push(...matches);
          this.nextLine =
            this.matches.length >= MAX_REGEX_MATCHES
              ? this.totalLines
              : firstLine + lines.length;
          if (this.nextLine >= this.totalLines) {
            this.runner?.dispose();
            this.runner = null;
          }
          this.generation++;
          this.changed();
        },
        (error: unknown) => {
          if (operation !== this.operation || this.disposed || this.suspended)
            return;
          if (this.model.revision() !== revision) {
            this.invalidate();
            return;
          }
          this.fail(
            error instanceof Error ? error.message : "Regex search failed.",
          );
          this.changed();
        },
      );
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error.message
          : "Regex search could not start.",
      );
    }
    return this.status();
  }

  select(direction: "next" | "previous"): GhosttySearchStatus {
    if (this.matches.length === 0) return this.status();
    if (this.selected < 0) {
      // Start from the viewport: the first match at or below its top for
      // "next", the last one above its bottom for "previous".
      const top = this.model.viewportOriginLine();
      const bottom = top + this.model.rows - 1;
      if (direction === "next") {
        const index = this.matches.findIndex((match) => match.line >= top);
        this.selected = index < 0 ? 0 : index;
      } else {
        let index = -1;
        for (let i = this.matches.length - 1; i >= 0; i--) {
          if (this.matches[i].line <= bottom) {
            index = i;
            break;
          }
        }
        this.selected = index < 0 ? this.matches.length - 1 : index;
      }
    } else {
      const count = this.matches.length;
      this.selected =
        (this.selected + (direction === "next" ? 1 : -1) + count) % count;
    }
    this.reveal(this.matches[this.selected]);
    this.generation += 1;
    return this.status();
  }

  viewportMatches(): readonly GhosttySearchViewportSpan[] {
    const top = this.model.viewportOriginLine();
    const bottom = top + this.model.rows - 1;
    const spans: GhosttySearchViewportSpan[] = [];
    for (let index = 0; index < this.matches.length; index++) {
      const match = this.matches[index];
      if (match.line < top || match.line > bottom) continue;
      spans.push({
        row: match.line - top,
        startColumn: match.startColumn,
        endColumn: match.endColumn,
        selected: index === this.selected,
      });
    }
    return spans;
  }

  status(): GhosttySearchStatus {
    const active = !!this.pattern && !this.error;
    return {
      active,
      pending: active && this.nextLine < this.totalLines,
      complete: !active || this.nextLine >= this.totalLines,
      generation: this.generation,
      totalMatches: this.matches.length,
      selectedIndex: this.selected,
    };
  }

  private cancel(): void {
    this.operation++;
    this.runner?.dispose();
    this.runner = null;
    this.pending = false;
    if (this.revisionTimer !== null) clearTimeout(this.revisionTimer);
    this.revisionTimer = null;
  }

  private fail(message: string): void {
    this.cancel();
    this.error = message;
    this.matches = [];
    this.selected = -1;
    this.nextLine = this.totalLines;
    this.generation++;
  }

  private restart(): void {
    this.cancel();
    this.matches = [];
    this.nextLine = 0;
    this.selected = -1;
    this.revision = this.model.revision();
    this.totalLines = this.pattern
      ? this.model.scrollPosition().history + this.model.rows
      : 0;
    this.scannedUnits = 0;
    this.startedAt = null;
    this.generation++;
  }

  /** Scrolls so the match is visible, keeping the viewport when it already is. */
  private reveal(match: RegexMatch): void {
    const top = this.model.viewportOriginLine();
    if (match.line >= top && match.line < top + this.model.rows) return;
    const { history } = this.model.scrollPosition();
    // Offsets count lines scrolled up from the bottom of history.
    const wantTop = Math.max(0, match.line - Math.floor(this.model.rows / 2));
    this.model.scrollTo(Math.max(0, history - wantTop));
  }
}
