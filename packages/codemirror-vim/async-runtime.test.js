import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import {
  input,
  request,
  ticket,
  check,
  continueVim,
  invalidate,
  RegexChannel,
} from "./async-runtime.js";
import { resumeVim } from "../codemirror-vim-core/resumable.js";
class Worker {
  static all = [];
  constructor() {
    Worker.all.push(this);
    this.terminate = vi.fn();
  }
  postMessage(data) {
    this.data = data;
  }
  reply(value) {
    this.onmessage?.({ data: { value } });
  }
}
function editor() {
  const cm = {
    cm6: { state: EditorState.create({ doc: "abc" }) },
    operation: (fn) => fn(),
    vimTicket: () => ticket(cm),
    vimCheck: (owner) => check(cm, owner),
    vimContinue: (owner, fn) => continueVim(cm, owner, fn),
    vimFailed: vi.fn(),
  };
  return cm;
}
const search = (cm) =>
  request(cm, { kind: "cursor", source: "a", flags: "", from: 0, back: false });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Worker.all = [];
});
describe("resumable Vim commands", () => {
  it("ordinary commands remain synchronous", () => {
    const cm = editor();
    expect(
      input(cm, () =>
        resumeVim(
          cm,
          (function* () {
            return (yield 3) + 1;
          })(),
        ),
      ),
    ).toBe(4);
    expect(Worker.all).toHaveLength(0);
  });
  it("preserves command order across editors sharing macro state", async () => {
    vi.stubGlobal("Worker", Worker);
    const a = editor(),
      b = editor(),
      order = [];
    const p = input(a, () =>
      resumeVim(
        a,
        (function* () {
          order.push("search");
          yield search(a);
          order.push("operator");
        })(),
      ),
    );
    const q = input(b, () => order.push("next editor"));
    expect(order).toEqual(["search"]);
    Worker.all[0].reply(null);
    await Promise.all([p, q]);
    expect(order).toEqual(["search", "operator", "next editor"]);
    expect(Worker.all[0].terminate).toHaveBeenCalledOnce();
  });
  it("invalidates continuations and queued keys on document ownership loss", async () => {
    vi.stubGlobal("Worker", Worker);
    const cm = editor(),
      mutate = vi.fn();
    const p = input(cm, () =>
      resumeVim(
        cm,
        (function* () {
          yield search(cm);
          mutate();
        })(),
      ),
    );
    const q = input(cm, mutate);
    const checks = [
      expect(p).rejects.toThrow("cancelled"),
      expect(q).rejects.toThrow("cancelled"),
    ];
    invalidate(cm);
    await Promise.all(checks);
    expect(mutate).not.toHaveBeenCalled();
    expect(input(cm, () => 7)).toBe(7);
  });
  it("checks ownership after a reply but before an outer continuation", async () => {
    vi.stubGlobal("Worker", Worker);
    const cm = editor(),
      mutate = vi.fn();
    const p = input(cm, () =>
      resumeVim(
        cm,
        (function* () {
          yield search(cm);
          mutate();
        })(),
      ),
    );
    const assertion = expect(p).rejects.toThrow("cancelled");
    Worker.all[0].reply(null);
    invalidate(cm);
    await assertion;
    expect(mutate).not.toHaveBeenCalled();
  });
  it("terminates a stalled worker and recovers for later commands", async () => {
    vi.stubGlobal("Worker", Worker);
    vi.useFakeTimers();
    const cm = editor();
    const p = input(cm, () => search(cm));
    const assertion = expect(p).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10001);
    await assertion;
    expect(Worker.all[0].terminate).toHaveBeenCalledOnce();
    expect(input(cm, () => 8)).toBe(8);
  });
  it("rejects a worker reply after a document changes", async () => {
    vi.stubGlobal("Worker", Worker);
    const cm = editor();
    const p = input(cm, () => search(cm));
    const assertion = expect(p).rejects.toThrow("cancelled");
    cm.cm6.state = cm.cm6.state.update({
      changes: { from: 0, insert: "new" },
    }).state;
    Worker.all[0].reply(null);
    await assertion;
  });
  it("rejects malformed responses and releases admission", async () => {
    vi.stubGlobal("Worker", Worker);
    const cm = editor();
    const p = input(cm, () => search(cm));
    const assertion = expect(p).rejects.toThrow("Invalid");
    Worker.all[0].reply(undefined);
    await assertion;
    expect(Worker.all[0].terminate).toHaveBeenCalledOnce();
  });
  it("limits worker admission and releases idle instances", () => {
    vi.stubGlobal("Worker", Worker);
    const channels = Array.from(
      { length: 5 },
      () => new RegexChannel(editor()),
    );
    const pending = channels
      .slice(0, 4)
      .map((c) =>
        c
          .request({ kind: "cursor", source: "x", flags: "", from: 0 })
          .catch(() => {}),
      );
    expect(() =>
      channels[4].request({ kind: "cursor", source: "x", flags: "", from: 0 }),
    ).toThrow("Too many");
    channels.forEach((c) => c.close());
    return Promise.all(pending);
  });
});
it("refuses resuming a mutation after editing becomes read-only", async () => {
  vi.stubGlobal("Worker", Worker);
  const cm = editor(),
    mutate = vi.fn();
  const pending = input(cm, () =>
    resumeVim(
      cm,
      (function* () {
        yield search(cm);
        mutate();
      })(),
    ),
  );
  const assertion = expect(pending).rejects.toThrow("cancelled");
  cm.cm6.state = cm.cm6.state.update({
    effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)),
  }).state;
  Worker.all[0].reply(null);
  await assertion;
  expect(mutate).not.toHaveBeenCalled();
});
it("bounds queued commands and discards them on overload", async () => {
  vi.stubGlobal("Worker", Worker);
  const cm = editor(),
    mutate = vi.fn();
  const active = input(cm, () => search(cm)).catch(() => {});
  const queued = Array.from({ length: 256 }, () =>
    input(cm, mutate).catch(() => {}),
  );
  expect(() => input(cm, mutate)).toThrow("queue is full");
  await Promise.all([active, ...queued]);
  expect(mutate).not.toHaveBeenCalled();
});
