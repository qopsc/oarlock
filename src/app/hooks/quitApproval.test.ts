import { afterEach, expect, it, vi } from "vitest";
import { QuitApproval, type QuitRequest } from "./quitApproval";
import {
  documentRevisionChanged,
  editorQuitSealed,
  releaseEditors,
} from "@/modules/editor/lib/quitBarrier";

const first: QuitRequest = { round: 1, ticket: 1, verify: false };
const final: QuitRequest = { round: 1, ticket: 3, verify: true };
const live: QuitApproval[] = [];
function setup() {
  let current = new Map<number, unknown>([[1, "old"]]);
  const host = {
    read: () => current,
    flush: vi.fn().mockResolvedValue(true),
    answer: vi.fn().mockResolvedValue(undefined),
    changed: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(true),
    resumed: vi.fn(),
    failed: vi.fn(),
  };
  const approval = new QuitApproval(host);
  live.push(approval);
  approval.begin(first);
  approval.approve(first, current);
  return {
    approval,
    host,
    edit: (revision = "new") => {
      current = new Map([[1, revision]]);
      documentRevisionChanged();
    },
  };
}
afterEach(async () => {
  for (const item of live.splice(0)) item.dispose();
  await Promise.resolve();
  await Promise.resolve();
  releaseEditors("1:3");
  releaseEditors("1:5");
  releaseEditors("2:3");
  vi.useRealTimers();
});
it("an approved editor stays editable and its first new edit invalidates approval", () => {
  const t = setup();
  expect(editorQuitSealed()).toBe(false);
  t.edit();
  t.edit("newer");
  expect(t.host.changed).toHaveBeenCalledExactlyOnceWith(first);
  t.approval.begin(final);
  t.approval.verify(final);
  expect(t.host.answer).toHaveBeenLastCalledWith(final, false);
  expect(editorQuitSealed()).toBe(false);
});
it("verification seals before sending its vote and resumes only for its own ticket", () => {
  const t = setup();
  t.host.answer.mockImplementation(async (request: QuitRequest) => {
    if (request.verify) expect(editorQuitSealed()).toBe(true);
  });
  t.approval.begin(final);
  t.approval.verify(final);
  expect(editorQuitSealed()).toBe(true);
  t.approval.resume({ round: 1, ticket: 2 });
  expect(editorQuitSealed()).toBe(true);
  t.approval.resume({ round: 1, ticket: 3 });
  expect(editorQuitSealed()).toBe(false);
});
it("new requests release a missed old seal and late release events cannot undo a new seal", () => {
  const t = setup();
  t.approval.begin(final);
  t.approval.verify(final);
  const retry = { ...first, ticket: 4 };
  t.approval.begin(retry);
  expect(editorQuitSealed()).toBe(false);
  t.approval.approve(retry, t.host.read());
  const check = { ...final, ticket: 5 };
  t.approval.begin(check);
  t.approval.verify(check);
  t.approval.resume({ round: 1, ticket: 3 });
  expect(editorQuitSealed()).toBe(true);
});
it("cancelled rounds ignore delayed requests and duplicate cancellation", () => {
  const t = setup();
  t.approval.resume({ round: 1, ticket: null });
  t.approval.resume({ round: 1, ticket: null });
  expect(t.host.resumed).toHaveBeenCalledOnce();
  expect(t.approval.begin(final)).toBe(false);
  t.edit();
  expect(t.host.changed).not.toHaveBeenCalled();
});
it("a watchdog waits for native cancellation before restoring editing", async () => {
  vi.useFakeTimers();
  const t = setup();
  let cancel!: (ok: boolean) => void;
  t.host.cancel.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        cancel = resolve;
      }),
  );
  t.approval.begin(final);
  t.approval.verify(final);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(editorQuitSealed()).toBe(true);
  cancel(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(editorQuitSealed()).toBe(false);
  expect(t.host.failed).toHaveBeenCalledOnce();
});
it("native commitment refuses watchdog cancellation and keeps the seal", async () => {
  const t = setup();
  t.host.cancel.mockResolvedValue(false);
  t.approval.begin(final);
  t.approval.verify(final);
  await t.approval.abort(1);
  expect(editorQuitSealed()).toBe(true);
});
it("a stale failed reply cannot cancel a newer round", async () => {
  const t = setup();
  let reject!: (error: Error) => void;
  t.host.answer.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  t.approval.begin(final);
  const verifying = t.approval.verify(final);
  await Promise.resolve();
  t.approval.begin({ ...first, round: 2 });
  reject(new Error("old failure"));
  await verifying;
  await Promise.resolve();
  await Promise.resolve();
  expect(t.host.cancel).not.toHaveBeenCalled();
  expect(editorQuitSealed()).toBe(false);
});

it("final verification waits for fresh persistence and does not answer after cancellation", async () => {
  const t = setup();
  let flush!: (ok: boolean) => void;
  t.host.flush.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        flush = resolve;
      }),
  );
  t.approval.begin(final);
  const verifying = t.approval.verify(final);
  expect(editorQuitSealed()).toBe(true);
  expect(t.host.answer).not.toHaveBeenCalledWith(final, true);
  t.approval.resume({ round: 1, ticket: null });
  flush(true);
  await verifying;
  expect(editorQuitSealed()).toBe(false);
  expect(t.host.answer).not.toHaveBeenCalledWith(final, true);
});
it("final persistence failure cancels the round without voting to exit", async () => {
  const t = setup();
  t.host.flush.mockResolvedValue(false);
  t.approval.begin(final);
  await t.approval.verify(final);
  expect(t.host.cancel).toHaveBeenCalledWith(1);
  expect(editorQuitSealed()).toBe(false);
  expect(t.host.answer).not.toHaveBeenCalledWith(final, true);
});

it("a change noticed during final persistence cannot cast an exit vote", async () => {
  const t = setup();
  let flush!: (ok: boolean) => void;
  t.host.flush.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        flush = resolve;
      }),
  );
  t.approval.begin(final);
  const verifying = t.approval.verify(final);
  t.edit();
  flush(true);
  await verifying;
  expect(t.host.answer).toHaveBeenLastCalledWith(final, false);
});
it("a successful final vote follows both sealing and fresh persistence", async () => {
  const t = setup();
  t.approval.begin(final);
  await t.approval.verify(final);
  expect(t.host.flush).toHaveBeenCalledOnce();
  expect(editorQuitSealed()).toBe(true);
  expect(t.host.answer).toHaveBeenLastCalledWith(final, true);
});

it("verification cannot take over a local close already committing", async () => {
  const { sealEditors } = await import("@/modules/editor/lib/quitBarrier");
  const t = setup();
  sealEditors("local-close");
  try {
    t.approval.begin(final);
    await t.approval.verify(final);
    expect(t.host.cancel).toHaveBeenCalledWith(1);
    expect(t.host.answer).not.toHaveBeenCalledWith(final, true);
    expect(editorQuitSealed()).toBe(true);
  } finally {
    releaseEditors("local-close");
  }
});

it("a failed cancellation from an older verification cannot retry against its replacement", async () => {
  vi.useFakeTimers();
  const t = setup();
  t.approval.begin(final);
  await t.approval.verify(final);
  let failCancel!: (reason: Error) => void;
  t.host.cancel.mockImplementationOnce(
    () =>
      new Promise<boolean>((_resolve, reject) => {
        failCancel = reject;
      }),
  );
  const obsolete = t.approval.abort(1, true);
  t.approval.resume({ round: 1, ticket: 3 });
  const replacement = { ...first, ticket: 4 };
  t.approval.begin(replacement);
  t.approval.approve(replacement, t.host.read());
  const verification = { ...final, ticket: 5 };
  t.approval.begin(verification);
  await t.approval.verify(verification);
  failCancel(new Error("old IPC failure"));
  await obsolete;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(t.host.cancel).toHaveBeenCalledTimes(1);
  expect(t.host.failed).not.toHaveBeenCalled();
  expect(editorQuitSealed()).toBe(true);
});
it("overlapping cancellation failures keep only one retry and disposal still releases its seal", async () => {
  vi.useFakeTimers();
  const t = setup();
  t.approval.begin(final);
  await t.approval.verify(final);
  t.host.cancel.mockRejectedValue(new Error("offline"));
  await Promise.all([t.approval.abort(1), t.approval.abort(1)]);
  expect(vi.getTimerCount()).toBe(1);
  t.approval.dispose();
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(1);
  t.host.cancel.mockResolvedValue(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(editorQuitSealed()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("successful cancellation still ends the round when a replacement ticket arrived meanwhile", async () => {
  const t = setup();
  let finishCancel!: (ok: boolean) => void;
  t.host.cancel.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finishCancel = resolve;
      }),
  );
  const cancelling = t.approval.abort(1);
  t.approval.begin(final);
  await t.approval.verify(final);
  finishCancel(true);
  await cancelling;
  expect(editorQuitSealed()).toBe(false);
  expect(t.approval.isCurrent(final)).toBe(false);
});
