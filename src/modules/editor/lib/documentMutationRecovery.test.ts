import { expect, it, vi } from "vitest";
import { subscribeDocumentMutations, type DocumentMutation } from "./documentMutations";

const event = (sequence: number, from: string, to: string): DocumentMutation => ({
  sequence, kind: "renamed", workspace: { kind: "local" }, from, to,
});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

it("reconciles a failed mutation before applying the next queued rename", async () => {
  let receive!: (event: DocumentMutation) => void;
  const actions: string[] = [];
  const failedEvents: (DocumentMutation | undefined)[] = [];
  const stop = subscribeDocumentMutations(
    async (listener) => { receive = listener; return () => {}; },
    (item) => {
      actions.push(`apply ${item.sequence}`);
      if (item.sequence === 1) {
        receive(event(2, "/b", "/c"));
        throw new Error("failed after partial application");
      }
    },
    vi.fn(),
    vi.fn(),
    async (_scope, _isLive, failedEvent) => { actions.push("reconcile"); failedEvents.push(failedEvent); },
  );
  await flush();
  actions.length = 0;
  failedEvents.length = 0;
  receive(event(1, "/a", "/b"));
  await flush();
  expect(actions).toEqual(["apply 1", "reconcile", "apply 2"]);
  expect(failedEvents).toEqual([event(1, "/a", "/b")]);
  stop();
});

it("reconciles before applying an event after a sequence gap", async () => {
  let receive!: (event: DocumentMutation) => void;
  const actions: string[] = [];
  const stop = subscribeDocumentMutations(
    async (listener) => { receive = listener; return () => {}; },
    (item) => actions.push(`apply ${item.sequence}`), vi.fn(), vi.fn(),
    async () => { actions.push("reconcile"); },
  );
  await flush();
  actions.length = 0;
  receive(event(1, "/a", "/b"));
  receive(event(3, "/c", "/d"));
  await flush();
  expect(actions).toEqual(["apply 1", "reconcile", "apply 3"]);
  stop();
});

it("retains queued events for retry when reconciliation fails", async () => {
  let receive!: (event: DocumentMutation) => void;
  let retry: (() => void) | undefined;
  let rejectNext = false;
  const applied: number[] = [];
  const stop = subscribeDocumentMutations(
    async (listener) => { receive = listener; return () => {}; },
    (item) => { if (item.sequence === 1) throw new Error("apply"); applied.push(item.sequence); },
    (_error, again) => { retry = again; }, vi.fn(),
    async () => { if (rejectNext) { rejectNext = false; throw new Error("scan"); } },
  );
  await flush();
  rejectNext = true;
  receive(event(1, "/a", "/b"));
  receive(event(2, "/b", "/c"));
  await flush();
  expect(applied).toEqual([]);
  expect(retry).toBeTypeOf("function");
  retry?.();
  await flush();
  expect(applied).toEqual([2]);
  stop();
});
