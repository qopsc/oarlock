import { afterEach, expect, it, vi } from "vitest";
import { QuitApproval, type QuitRequest } from "./quitApproval";

const first: QuitRequest = { round: 1, ticket: 1, verify: false };
const final: QuitRequest = { round: 1, ticket: 3, verify: true };
const live: QuitApproval[] = [];
function setup() {
  let current = new Map<number, unknown>([[1, "old"]]);
  const host = {
    read: vi.fn(() => current),
    flush: vi.fn().mockResolvedValue(true),
    answer: vi.fn().mockResolvedValue(undefined),
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
    },
  };
}
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
afterEach(async () => {
  for (const item of live.splice(0)) item.dispose();
  await tick();
});

it("an edit after approval and before the final verify answers no", async () => {
  const t = setup();
  let finishFlush!: (saved: boolean) => void;
  t.host.flush.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      finishFlush = resolve;
    }),
  );
  t.approval.begin(final);
  const verifying = t.approval.verify(final);
  await tick();
  // The edit lands while the state flush is still pending; reading before the
  // flush resolved would miss it.
  t.edit();
  finishFlush(true);
  await verifying;
  expect(t.host.answer).toHaveBeenLastCalledWith(final, false);
});

it("unchanged revisions answer yes after the flush, reading in the same task as the answer", async () => {
  const t = setup();
  t.approval.begin(final);
  const order: string[] = [];
  t.host.flush.mockImplementationOnce(async () => {
    order.push("flush");
    return true;
  });
  t.host.read.mockImplementation(() => {
    order.push("read");
    return new Map([[1, "old"]]);
  });
  t.host.answer.mockImplementation(async (request: QuitRequest) => {
    order.push(request.verify ? "answer" : "approve");
  });
  await t.approval.verify(final);
  expect(order.slice(-3)).toEqual(["flush", "read", "answer"]);
  expect(t.host.answer).toHaveBeenLastCalledWith(final, true);
});

it("an edit after the verify answer is the accepted residual", async () => {
  const t = setup();
  t.approval.begin(final);
  await t.approval.verify(final);
  expect(t.host.answer).toHaveBeenLastCalledWith(final, true);
  const answers = t.host.answer.mock.calls.length;
  t.edit("later");
  await tick();
  expect(t.host.answer.mock.calls.length).toBe(answers);
  expect(t.host.cancel).not.toHaveBeenCalled();
});

it("a failed flush cancels the round instead of answering", async () => {
  const t = setup();
  t.host.flush.mockResolvedValueOnce(false);
  t.approval.begin(final);
  await t.approval.verify(final);
  expect(t.host.cancel).toHaveBeenCalledWith(1);
  expect(t.host.answer).not.toHaveBeenCalledWith(final, true);
});

it("a stale verification request is ignored", async () => {
  const t = setup();
  t.approval.begin(final);
  t.approval.begin({ round: 1, ticket: 5, verify: true });
  await t.approval.verify(final);
  expect(t.host.answer).not.toHaveBeenCalledWith(final, true);
  expect(t.host.answer).not.toHaveBeenCalledWith(final, false);
});

it("a cancelled round ignores later requests and reports the resume once", async () => {
  const t = setup();
  t.approval.resume({ round: 1 });
  expect(t.host.resumed).toHaveBeenCalledOnce();
  expect(t.approval.begin({ round: 1, ticket: 9, verify: true })).toBe(false);
});

it("a failed cancellation request reports a failed quit without resuming", async () => {
  const t = setup();
  t.host.cancel.mockRejectedValueOnce(new Error("ipc"));
  await t.approval.abort(1, true);
  expect(t.host.failed).toHaveBeenCalledOnce();
  expect(t.host.resumed).not.toHaveBeenCalled();
});

it("disposal cancels an unfinished round", async () => {
  const t = setup();
  t.approval.dispose();
  await tick();
  expect(t.host.cancel).toHaveBeenCalledWith(1);
});

it("a missing approval answers no", async () => {
  const host = {
    read: () => new Map<number, unknown>(),
    flush: vi.fn().mockResolvedValue(true),
    answer: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(true),
    resumed: vi.fn(),
    failed: vi.fn(),
  };
  const approval = new QuitApproval(host);
  live.push(approval);
  approval.begin(final);
  await approval.verify(final);
  expect(host.answer).toHaveBeenCalledWith(final, false);
});
