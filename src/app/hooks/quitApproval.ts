import {
  subscribeDocumentRevision,
  sealEditors,
  releaseEditors,
  editorMutationsPending,
} from "@/modules/editor/lib/quitBarrier";

export type QuitRequest = { round: number; ticket: number; verify: boolean };
export type QuitResume = {
  round: number;
  ticket: number | null;
  message?: string;
};
export type Revisions = Map<number, unknown>;
export const hasNewEdits = (current: Revisions, approved: Revisions) =>
  [...current].some(
    ([id, revision]) => !approved.has(id) || approved.get(id) !== revision,
  );

type Host = {
  read: () => Revisions;
  flush: () => Promise<boolean>;
  answer: (request: QuitRequest, ok: boolean) => Promise<unknown>;
  changed: (request: QuitRequest) => Promise<unknown>;
  cancel: (round: number) => Promise<boolean>;
  resumed: (cancelled: boolean) => void;
  failed: () => void;
  interrupted?: () => void;
};

/** Owns approval snapshots through the native quit round, including its final
 * seal. All effects are injected except the window-local editor barrier. */
export class QuitApproval {
  private request: QuitRequest | null = null;
  private approved: Revisions | null = null;
  private unsubscribe: (() => void) | null = null;
  private sealed: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private endedRound = -1;
  private mutationCancellation = false;
  constructor(private readonly host: Host) {}

  activate(): void {
    this.disposed = false;
  }

  begin(request: QuitRequest): boolean {
    if (
      this.disposed ||
      request.round <= this.endedRound ||
      (this.request &&
        (request.round < this.request.round ||
          (request.round === this.request.round &&
            request.ticket <= this.request.ticket)))
    )
      return false;
    if (this.request?.round !== request.round) this.clearApproval();
    // A newer native request proves the previous verification was abandoned,
    // even if its release event was lost.
    this.release();
    this.mutationCancellation = false;
    this.request = request;
    return true;
  }
  isCurrent(request: QuitRequest): boolean {
    return (
      !this.disposed &&
      request.round > this.endedRound &&
      this.request?.round === request.round &&
      this.request.ticket === request.ticket
    );
  }
  approve(request: QuitRequest, revisions: Revisions): void {
    if (!this.isCurrent(request)) return;
    this.clearApproval();
    this.approved = revisions;
    this.unsubscribe = subscribeDocumentRevision(() => {
      if (!this.approved || !hasNewEdits(this.host.read(), this.approved))
        return;
      this.clearApproval();
      void this.host.changed(request).catch(() => {
        if (this.isCurrent(request)) return this.abort(request.round, true);
      });
    });
    void this.host.answer(request, true).catch(() => {
      if (this.isCurrent(request)) return this.abort(request.round, true);
    });
  }
  async verify(request: QuitRequest): Promise<void> {
    if (!this.isCurrent(request)) return;
    if (!this.approved || hasNewEdits(this.host.read(), this.approved)) {
      void this.host.answer(request, false).catch(() => {
        if (this.isCurrent(request)) return this.abort(request.round, true);
      });
      return;
    }
    const key = `${request.round}:${request.ticket}`;
    if (
      !sealEditors(key, () => {
        this.mutationCancellation = true;
        void this.abort(request.round);
      })
    ) {
      await this.abort(request.round);
      return;
    }
    this.sealed = key;
    // Native has a five-second deadline. This watchdog also covers a missed
    // release event, and only unseals once native confirms it cannot exit.
    this.timer = setTimeout(() => {
      if (this.request === request) void this.abort(request.round, true);
    }, 6_000);
    try {
      const saved = await this.host.flush();
      if (
        !this.isCurrent(request) ||
        this.sealed !== `${request.round}:${request.ticket}`
      )
        return;
      if (!saved) {
        await this.abort(request.round);
        return;
      }
      const unchanged =
        this.approved !== null &&
        !editorMutationsPending() &&
        !hasNewEdits(this.host.read(), this.approved);
      await this.host.answer(request, unchanged);
    } catch {
      if (this.isCurrent(request)) await this.abort(request.round, true);
    }
  }
  resume(event: QuitResume): void {
    if (this.request?.round !== event.round || event.round <= this.endedRound)
      return;
    if (
      event.ticket !== null &&
      this.sealed !== `${event.round}:${event.ticket}`
    )
      return;
    if (event.ticket === null) {
      this.endedRound = event.round;
      this.clearApproval();
    }
    this.release();
    this.host.resumed(event.ticket === null);
    if (event.ticket === null && this.mutationCancellation) {
      this.mutationCancellation = false;
      this.host.interrupted?.();
    }
    // Keep the last ticket to reject delayed messages from the ended phase.
  }
  async abort(round: number, failed = false): Promise<void> {
    const request = this.request;
    if (request?.round !== round || round <= this.endedRound) return;
    try {
      const cancelled = await this.host.cancel(round);
      if (this.request?.round !== round || round <= this.endedRound) return;
      if (cancelled) {
        this.resume({ round, ticket: null });
        if (failed) this.host.failed();
      }
    } catch {
      // Native success cancels the whole round, but a failed request must not
      // install a retry or show an error for a replacement verification ticket.
      if (this.request !== request || round <= this.endedRound) return;
      if (failed) this.host.failed();
      // A failed IPC cannot prove native did not commit. Keep the seal and
      // retry, only while a final check actually owns a seal.
      if (this.sealed) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          if (this.request === request) void this.abort(round, true);
        }, 1_000);
      }
    }
  }
  dispose(): void {
    this.disposed = true;
    this.clearApproval();
    if (this.request && this.request.round > this.endedRound)
      void this.abort(this.request.round);
  }
  private clearApproval(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.approved = null;
  }
  private release(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const key = this.sealed;
    this.sealed = null;
    if (key) releaseEditors(key);
  }
}
