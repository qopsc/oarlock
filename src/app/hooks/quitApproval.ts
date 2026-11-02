export type QuitRequest = { round: number; ticket: number; verify: boolean };
export type QuitResume = { round: number; message?: string };
export type Revisions = Map<number, unknown>;
export const hasNewEdits = (current: Revisions, approved: Revisions) =>
  [...current].some(
    ([id, revision]) => !approved.has(id) || approved.get(id) !== revision,
  );

type Host = {
  read: () => Revisions;
  flush: () => Promise<boolean>;
  answer: (request: QuitRequest, ok: boolean) => Promise<unknown>;
  cancel: (round: number) => Promise<boolean>;
  resumed: () => void;
  failed: () => void;
};

/** Owns this window's approval snapshot through a native quit round. Editing is
 * never blocked: the final verification flushes state, then reads the dirty
 * revisions and answers in the same task. An edit made after the approval makes
 * the answer no, and native asks this window again; an edit made after the
 * answer, before the process exits, is the accepted residual. */
export class QuitApproval {
  private request: QuitRequest | null = null;
  private approved: Revisions | null = null;
  private disposed = false;
  private endedRound = -1;
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
    if (this.request?.round !== request.round) this.approved = null;
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
    this.approved = revisions;
    this.send(request, true);
  }
  async verify(request: QuitRequest): Promise<void> {
    if (!this.isCurrent(request)) return;
    if (!this.approved) {
      this.send(request, false);
      return;
    }
    try {
      if (!(await this.host.flush())) {
        await this.abort(request.round);
        return;
      }
    } catch {
      if (this.isCurrent(request)) await this.abort(request.round, true);
      return;
    }
    if (!this.isCurrent(request) || !this.approved) return;
    this.send(request, !hasNewEdits(this.host.read(), this.approved));
  }
  resume(event: QuitResume): void {
    if (this.request?.round !== event.round || event.round <= this.endedRound)
      return;
    this.endedRound = event.round;
    this.approved = null;
    this.host.resumed();
  }
  async abort(round: number, failed = false): Promise<void> {
    const request = this.request;
    if (request?.round !== round || round <= this.endedRound) return;
    try {
      const cancelled = await this.host.cancel(round);
      if (this.request?.round !== round || round <= this.endedRound) return;
      if (cancelled) {
        this.resume({ round });
        if (failed) this.host.failed();
      }
    } catch {
      if (this.request !== request || round <= this.endedRound) return;
      if (failed) this.host.failed();
    }
  }
  dispose(): void {
    this.disposed = true;
    this.approved = null;
    if (this.request && this.request.round > this.endedRound)
      void this.abort(this.request.round);
  }
  private send(request: QuitRequest, ok: boolean): void {
    void this.host.answer(request, ok).catch(() => {
      if (this.isCurrent(request)) return this.abort(request.round, true);
    });
  }
}
