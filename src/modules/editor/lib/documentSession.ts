import {
  beginDocumentMutation,
  deferEditorLifecycle,
  documentRevisionChanged,
  editorQuitSealed,
} from "./quitBarrier";
import { detectEol, type Eol, normalizeToLf, restoreEol } from "./eol";
import type { RecoveryTarget } from "./recoveryTarget";
import { consumeRetarget } from "./pathRetarget";

export type ReadResult =
  | {
      kind: "text";
      content: string;
      size: number;
      mtime: number;
      version?: string;
      aiContextAllowed?: boolean;
    }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type DocumentState =
  | { status: "loading" }
  | { status: "ready"; content: string; size: number }
  | { status: "binary"; size: number }
  | { status: "toolarge"; size: number; limit: number }
  | { status: "error"; message: string };

export type SaveResult =
  | { kind: "saved"; version: string }
  | { kind: "conflict"; version: string | null };
export type DocumentIo = {
  observeRecovery?: (path: string) => RecoveryTarget | Promise<RecoveryTarget>;
  read: (path: string, force: boolean) => Promise<ReadResult>;
  /** Native compares the exact disk baseline under its per-file transaction lock. */
  write: (
    path: string,
    text: string,
    expectedVersion: string | null,
  ) => Promise<SaveResult>;
};

export type DiscardPreparation = { complete: () => void; dispose: () => void };
export type DiscardCandidate = {
  select: (matched: boolean) => DiscardPreparation;
};

export type DocumentHost = {
  state: (doc: DocumentState) => void;
  dirty: (dirty: boolean) => void;
  saved: (path: string) => void;
  /** The write failed; the buffer stays dirty. */
  saveFailed: (path: string, error: unknown) => void;
  /** A conflict retains the buffer; `overwrite` rechecks the observed disk version. */
  conflict: (path: string, overwrite: () => void) => void;
  /** Notices tied to `path` no longer apply: the pane moved on or closed. */
  released: (path: string) => void;
  binding?: (path: string, detached: boolean) => void;
  retained?: (path: string) => void;
  autoSave: () => { enabled: boolean; delay: number };
};

/**
 * One editor pane's document: the buffer, its saved baseline and the disk
 * state it was read from. Every async step remembers the epoch it started in
 * and is dropped once the pane loaded another file, was retargeted by a
 * rename, or closed, so a late result never lands on the wrong path.
 */
let nextSessionIdentity = 0;

export class DocumentSession {
  private readonly sessionIdentity = ++nextSessionIdentity;
  private path: string | null = null;
  private active = false;
  private detached = false;
  private epoch = 0;
  // Reads within one document can finish out of order. Writes and formatter
  // baselines also supersede any snapshot captured before they completed.
  private readGeneration = 0;
  // The path the buffer's text was read from; null while loading or non-text.
  private loadedPath: string | null = null;
  private aiAllowed = false;
  canComplete = (path: string): boolean =>
    this.active &&
    !this.detached &&
    this.path === path &&
    this.loadedPath === path &&
    this.aiAllowed;
  private saved = "";
  private buffer = "";
  // Bumped on every edit, so a forced read can tell whether it raced one.
  private revision = 0;
  private eol: Eol = "\n";
  private savedEol: Eol = "\n";
  private isDirty = false;
  private diskVersion: string | undefined;
  private pendingDiscards: Map<object, number> | undefined;
  private discardReadSuppressed = false;
  private recoveryTarget: RecoveryTarget | undefined;
  private saveTail: Promise<unknown> = Promise.resolve();
  // "Open anyway" was chosen: reads of this file lift the size limit.
  private force = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerGeneration = 0;

  constructor(
    private readonly io: DocumentIo,
    private readonly host: DocumentHost,
  ) {}

  open(path: string): void {
    if (deferEditorLifecycle(this, "binding", () => this.open(path))) return;
    const prev = this.path;
    if (prev === path && this.active) return;
    this.active = true;
    this.path = path;
    if (prev !== null && prev !== path) {
      this.release(prev);
      // The explorer renamed or moved this file: keep the buffer, dirty
      // state, EOL and disk version instead of reloading. The note is consumed
      // either way so it cannot match a later path change.
      if (
        consumeRetarget(prev, path) &&
        !this.detached &&
        this.loadedPath === prev
      ) {
        this.epoch += 1;
        this.loadedPath = path;
        documentRevisionChanged();
        this.armAutoSave();
        return;
      }
    }
    this.load(false);
  }

  close(): void {
    if (deferEditorLifecycle(this, "binding", () => this.close())) return;
    if (!this.active) return;
    this.active = false;
    this.epoch += 1;
    documentRevisionChanged();
    if (this.path !== null) this.release(this.path);
  }

  openAnyway = (): void => {
    if (deferEditorLifecycle(this, "reload", this.openAnyway)) return;
    if (this.active && this.path !== null) this.load(true);
  };

  change = (text: string): void => {
    if (editorQuitSealed()) {
      // A programmatic view transaction may bypass CodeMirror's input filter.
      // It cannot change the owned buffer; restore that view if quit is aborted.
      const epoch = this.epoch;
      deferEditorLifecycle(this, "restoreView", () => {
        if (
          this.active &&
          epoch === this.epoch &&
          this.loadedPath === this.path
        )
          this.host.state({
            status: "ready",
            content: this.buffer,
            size: this.buffer.length,
          });
      });
      return;
    }
    this.buffer = text;
    this.revision += 1;
    this.setDirty(
      this.detached || text !== this.saved || this.eol !== this.savedEol,
    );
    this.clearTimer();
    this.armAutoSave();
  };

  // Never rejects: a failed write is reported through the host.
  save = async (): Promise<boolean> => {
    this.clearTimer();
    if (this.detached) {
      this.host.saveFailed(
        this.path ?? "",
        new Error(
          "This draft is detached. Use Restore file or Save As to recover it.",
        ),
      );
      return false;
    }
    return this.saveNow();
  };

  /** Candidate formatting owns one document snapshot. It never writes the path
   * itself; newer typing, navigation, reloads and completed saves supersede it. */
  formatAndSave = async (
    format: (
      path: string,
      content: string,
    ) => Promise<{ content: string; size: number }>,
  ): Promise<boolean> => {
    const path = this.path;
    if (
      !this.active ||
      this.detached ||
      path === null ||
      this.loadedPath !== path
    )
      return false;
    const suspendedAutoSave = this.timer !== null;
    this.clearTimer();
    const timerGeneration = this.timerGeneration;
    const epoch = this.epoch,
      revision = this.revision,
      generation = this.readGeneration;
    let adopted = false;
    try {
      const candidate = await format(path, restoreEol(this.buffer, this.eol));
      if (
        editorQuitSealed() ||
        !this.active ||
        epoch !== this.epoch ||
        revision !== this.revision ||
        generation !== this.readGeneration
      )
        return false;
      adopted = true;
      const content = normalizeToLf(candidate.content);
      this.eol = detectEol(candidate.content);
      this.change(content);
      this.host.state({ status: "ready", content, size: candidate.size });
      return this.save();
    } finally {
      // Preparation suspended autosave. Failed or superseded candidates must
      // restore it, without restarting a timer paused by a save conflict.
      if (
        !adopted &&
        suspendedAutoSave &&
        timerGeneration === this.timerGeneration &&
        this.active &&
        epoch === this.epoch &&
        this.timer === null
      )
        this.armAutoSave();
    }
  };

  isDetached = (): boolean => this.detached;

  detach = (): void => {
    const epoch = this.epoch;
    if (
      deferEditorLifecycle(this, "detach", () => {
        if (epoch === this.epoch) this.detach();
      })
    )
      return;
    if (
      !this.active ||
      this.path === null ||
      this.loadedPath !== this.path ||
      this.detached
    )
      return;
    this.detached = true;
    this.epoch += 1;
    this.readGeneration += 1;
    this.aiAllowed = false;
    this.clearTimer();
    this.host.released(this.path);
    this.setDirty(true);
    this.host.binding?.(this.path, true);
  };

  /** Recovery keeps the draft detached until the created file is revalidated. */
  recover = (target: string): Promise<boolean> => {
    const epoch = this.epoch;
    const recovery = this.saveTail.then(async () => {
      if (
        !this.active ||
        !this.detached ||
        epoch !== this.epoch ||
        editorQuitSealed()
      )
        return false;
      const content = this.buffer,
        eol = this.eol;
      let observed: RecoveryTarget | undefined;
      const current = () => this.active && epoch === this.epoch;
      const interrupted = () =>
        new Error(
          "Recovery was interrupted because the destination changed or closing began. Your draft is still detached. Check the destination before trying Restore file or Save As again.",
        );
      try {
        observed = await this.io.observeRecovery?.(target);
        if (!current()) return false;
        this.recoveryTarget = observed;
        const result = await this.io.write(
          target,
          restoreEol(content, eol),
          null,
        );
        if (!current()) return false;
        if (result.kind === "conflict")
          throw new Error(
            "A file already exists there. Choose another path with Save As; your draft is unchanged.",
          );
        const changed = await observed?.changed();
        if (!current()) return false;
        if (changed || editorQuitSealed()) throw interrupted();
        // Include native file identity, not just equal bytes. Never reload a
        // replacement into a draft or mark it saved on an obsolete write reply.
        const disk = await this.io.read(target, this.force);
        if (!current()) return false;
        const changedAfterRead = await observed?.changed();
        if (!current()) return false;
        if (
          changedAfterRead ||
          editorQuitSealed() ||
          disk.kind !== "text" ||
          disk.version !== result.version
        )
          throw interrupted();
        if (this.path !== null) this.host.released(this.path);
        this.path = this.loadedPath = target;
        this.detached = false;
        this.epoch += 1;
        this.readGeneration += 1;
        this.diskVersion = result.version;
        this.aiAllowed = disk.aiContextAllowed ?? false;
        this.saved = content;
        this.savedEol = eol;
        this.setDirty(this.buffer !== content || this.eol !== eol);
        this.host.binding?.(target, false);
        this.host.saved(target);
        this.armAutoSave();
        return true;
      } catch (error) {
        if (current()) this.host.saveFailed(target, error);
        return false;
      } finally {
        observed?.dispose();
        if (this.recoveryTarget === observed) this.recoveryTarget = undefined;
      }
    });
    this.saveTail = recovery;
    return recovery;
  };

  /** The text the editor view must show. */
  text = (): string => this.buffer;

  hasUnsavedChanges = (): boolean => {
    if (this.isDirty) return true;
    // A successful autosave is not durable against Git that is still running.
    for (const revision of this.pendingDiscards?.values() ?? [])
      if (revision !== this.revision) return true;
    return false;
  };

  closeRevision = (): string =>
    `${this.sessionIdentity}:${this.epoch}:${this.revision}`;

  /** Live state for save-and-close; a successful write may have raced more typing. */
  isSaved = (): boolean =>
    this.active &&
    !this.detached &&
    this.loadedPath !== null &&
    this.loadedPath === this.path &&
    !this.hasUnsavedChanges();

  /** Protect the confirmation-time revision while native resolves path aliases.
   * Unrelated candidates do not cancel saves or formatter work. */
  stageDiscard = (preserveAll = false): DiscardCandidate => {
    const empty = { complete: () => {}, dispose: () => {} };
    if (!this.active || this.detached || this.path === null)
      return { select: () => empty };
    let epoch = this.epoch;
    const revision = this.revision;
    const token = {};
    const pending = this.pendingDiscards ?? new Map();
    this.pendingDiscards = pending;
    pending.set(token, preserveAll ? -1 : revision);
    const remove = () => {
      pending.delete(token);
      if (pending.size === 0 && this.pendingDiscards === pending)
        this.pendingDiscards = undefined;
      if (this.active) this.host.dirty(this.hasUnsavedChanges());
      documentRevisionChanged();
    };
    this.host.dirty(this.hasUnsavedChanges());
    documentRevisionChanged();
    let selected = false;
    return {
      select: (matched) => {
        if (selected) return empty;
        selected = true;
        if (!matched || !this.active || this.detached || epoch !== this.epoch) {
          remove();
          // A watcher read may have been suppressed during the identity lookup.
          if (
            this.active &&
            epoch === this.epoch &&
            this.discardReadSuppressed
          ) {
            this.discardReadSuppressed = false;
            this.reload();
          }
          return empty;
        }
        this.clearTimer();
        if (this.loadedPath === this.path) {
          epoch = ++this.epoch;
          this.readGeneration += 1;
          documentRevisionChanged();
        }
        let live = true;
        const finish = (failed: boolean) => {
          if (!live) return;
          live = false;
          const mutation = beginDocumentMutation();
          const apply = () => {
            try {
              if (
                !this.active ||
                this.detached ||
                epoch !== this.epoch ||
                this.path === null
              )
                return;
              if (this.loadedPath !== this.path) {
                this.load(this.force);
                return;
              }
              const newer = revision !== this.revision;
              this.epoch += 1;
              this.readGeneration += 1;
              this.clearTimer();
              this.diskVersion = undefined;
              this.setDirty(true);
              if (newer || preserveAll) this.host.retained?.(this.path);
              // Failed Git commands can have changed a subset of their paths. Read
              // their final baseline but never throw away any buffer on failure.
              this.reload({
                force: true,
                discard: true,
                preserve: failed || newer || preserveAll,
              });
            } finally {
              remove();
              mutation.release();
            }
          };
          if (mutation.ready) void mutation.ready.then(apply);
          else apply();
        };
        return { complete: () => finish(false), dispose: () => finish(true) };
      },
    };
  };

  prepareDiscard = (preserveAll = false): DiscardPreparation =>
    this.stageDiscard(preserveAll).select(true);

  // Skipped while dirty: never clobber unsaved edits. Re-checked when the
  // read resolves, since typing can start while it is in flight. `force`
  // replaces unsaved edits the user threw away on purpose (git discard);
  // edits typed while that read is in flight still win.
  reload = (options?: {
    force?: boolean;
    discard?: boolean;
    preserve?: boolean;
  }): boolean => {
    const path = this.path;
    const force = options?.force === true;
    if ((this.pendingDiscards?.size ?? 0) > 0 && !options?.discard) {
      this.discardReadSuppressed = true;
      return false;
    }
    if (
      !this.active ||
      this.detached ||
      path === null ||
      (this.isDirty && !force)
    ) {
      return false;
    }
    // A pending autosave would write the discarded text back.
    this.discardReadSuppressed = false;
    if (force) this.clearTimer();
    const epoch = this.epoch;
    const generation = ++this.readGeneration;
    const revision = this.revision;
    this.io.read(path, this.force).then(
      (res) => {
        if (epoch !== this.epoch || generation !== this.readGeneration) return;
        if ((this.pendingDiscards?.size ?? 0) > 0 && !options?.discard) {
          this.discardReadSuppressed = true;
          return;
        }
        if (!force) {
          if (!this.isDirty && revision === this.revision)
            this.adopt(res, true);
        } else if (this.revision === revision && !options?.preserve) {
          this.adopt(res);
        } else if (res.kind === "text") {
          this.adoptDiskText(res.content, res.version, res.aiContextAllowed);
          if (options?.discard && this.timer === null) this.armAutoSave();
        } else if (options?.discard) {
          this.detach();
        }
      },
      // Transient failures (e.g. ENOENT mid atomic-rename) must not replace
      // a healthy buffer with an error screen.
      (e) => {
        if (
          options?.discard &&
          epoch === this.epoch &&
          generation === this.readGeneration
        ) {
          this.detach();
          this.host.saveFailed(
            path,
            new Error(
              `Discard finished but the file could not be read. Your draft has been retained. ${String(e)}`,
            ),
          );
        } else console.warn("[editor] reload failed", path, e);
      },
    );
    return true;
  };

  // A forced reload raced newer typing: update the disk baseline without
  // replacing the buffer. An absent version keeps later saves blocked.
  adoptDiskText = (
    diskText: string,
    version: string | undefined,
    aiContextAllowed = false,
  ): string => {
    this.readGeneration += 1;
    this.aiAllowed = this.aiAllowed && aiContextAllowed;
    this.eol = detectEol(diskText);
    this.savedEol = this.eol;
    this.diskVersion = version;
    const content = normalizeToLf(diskText);
    this.saved = content;
    this.setDirty(this.buffer !== content);
    return content;
  };

  private load(force: boolean): void {
    const path = this.path;
    if (path === null) return;
    const epoch = ++this.epoch;
    const generation = ++this.readGeneration;
    this.force = force;
    if (this.detached) {
      this.detached = false;
      this.host.binding?.(path, false);
    }
    this.loadedPath = null;
    this.diskVersion = undefined;
    this.saved = "";
    this.buffer = "";
    this.clearTimer();
    this.setDirty(false);
    this.host.state({ status: "loading" });
    this.io.read(path, force).then(
      (res) => {
        if (epoch === this.epoch && generation === this.readGeneration)
          this.adopt(res);
      },
      (e) => {
        if (epoch === this.epoch && generation === this.readGeneration) {
          this.host.state({ status: "error", message: String(e) });
        }
      },
    );
  }

  // `keepIfUnchanged` skips the re-render when disk already matches the
  // baseline (self-save, duplicate watcher event); loads always publish.
  private adopt(res: ReadResult, keepIfUnchanged = false): void {
    const epoch = this.epoch,
      generation = this.readGeneration;
    if (
      deferEditorLifecycle(this, "adopt", () => {
        if (
          epoch === this.epoch &&
          generation === this.readGeneration &&
          this.active
        )
          this.adopt(res, keepIfUnchanged);
      })
    )
      return;
    if (res.kind !== "text") {
      this.loadedPath = null;
      this.aiAllowed = false;
      this.host.state(
        res.kind === "binary"
          ? { status: "binary", size: res.size }
          : { status: "toolarge", size: res.size, limit: res.limit },
      );
      return;
    }
    this.eol = detectEol(res.content);
    this.savedEol = this.eol;
    this.diskVersion = res.version;
    const content = normalizeToLf(res.content);
    if (
      keepIfUnchanged &&
      this.loadedPath === this.path &&
      content === this.saved &&
      this.aiAllowed === (res.aiContextAllowed === true)
    ) {
      return;
    }
    this.loadedPath = this.path;
    this.aiAllowed = res.aiContextAllowed === true;
    this.saved = content;
    this.buffer = content;
    this.setDirty(false);
    this.host.state({ status: "ready", content, size: res.size });
  }

  // Queue a pane's saves so a second save observes the first one's returned
  // baseline. Native ownership also protects other panes/windows.
  private saveNow(overwrite?: { version: string | null }): Promise<boolean> {
    const epoch = this.epoch;
    const saving = this.saveTail.then(() => this.write(epoch, overwrite));
    this.saveTail = saving;
    return saving;
  }

  private async write(
    epoch: number,
    overwrite?: { version: string | null },
  ): Promise<boolean> {
    const path = this.path;
    if (
      !this.active ||
      this.detached ||
      epoch !== this.epoch ||
      path === null ||
      this.loadedPath !== path
    )
      return false;
    if (!overwrite && this.buffer === this.saved && this.eol === this.savedEol)
      return true;
    const expected = overwrite ? overwrite.version : this.diskVersion;
    if (expected === undefined) {
      this.host.saveFailed(
        path,
        new Error(
          "The document's disk version is unavailable. Reload before saving.",
        ),
      );
      return false;
    }
    const content = this.buffer;
    const eol = this.eol;
    let result: SaveResult;
    try {
      result = await this.io.write(
        path,
        restoreEol(content, this.eol),
        expected,
      );
    } catch (error) {
      if (epoch === this.epoch) this.host.saveFailed(path, error);
      return false;
    }
    if (epoch !== this.epoch) return false;
    if (result.kind === "conflict") {
      this.clearTimer();
      const generation = this.readGeneration;
      this.host.conflict(path, () => {
        if (epoch === this.epoch && generation === this.readGeneration)
          void this.saveNow({ version: result.version });
      });
      return false;
    }
    this.readGeneration += 1;
    this.diskVersion = result.version;
    this.saved = content;
    this.savedEol = eol;
    this.setDirty(this.buffer !== content || this.eol !== eol);
    if (this.isDirty && this.timer === null) this.armAutoSave();
    this.host.saved(path);
    return true;
  }

  private armAutoSave(): void {
    if (this.detached || !this.isDirty) return;
    const { enabled, delay } = this.host.autoSave();
    if (!enabled) return;
    this.timerGeneration += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.saveNow();
    }, delay);
  }

  private clearTimer(): void {
    this.timerGeneration += 1;
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private release(path: string): void {
    this.pendingDiscards = undefined;
    this.discardReadSuppressed = false;
    this.recoveryTarget?.dispose();
    this.recoveryTarget = undefined;
    this.clearTimer();
    this.host.released(path);
  }

  private setDirty(dirty: boolean): void {
    this.isDirty = dirty;
    this.host.dirty(this.hasUnsavedChanges());
    documentRevisionChanged();
  }
}
