import { describe, expect, it, vi } from "vitest";
import { BoundedPtyWriter } from "./BoundedPtyWriter";
import type { PtySession } from "./pty-bridge";

const KiB = 1024;

/** A PTY whose writes complete when the test says. */
function stalledPty() {
  const writes: Uint8Array[] = [];
  let release: (() => void) | undefined;
  const pty: PtySession = {
    id: 1,
    write: vi.fn(async (data: string | Uint8Array) => {
      writes.push(data as Uint8Array);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }),
    resize: async () => undefined,
    close: async () => undefined,
  };
  return { pty, writes, release: () => release?.() };
}

describe("BoundedPtyWriter", () => {
  it("refuses input past its budget without stopping the writer", () => {
    const failed = vi.fn();
    const refused = vi.fn();
    const writer = new BoundedPtyWriter(failed, refused);
    expect(writer.enqueue(new Uint8Array(200 * KiB))).toBe(true);
    expect(writer.enqueue(new Uint8Array(100 * KiB))).toBe(true);
    expect(writer.enqueue(new Uint8Array(56 * KiB))).toBe(false);
    expect(refused).toHaveBeenCalledWith("input-full");
    expect(failed).not.toHaveBeenCalled();
    expect(writer.pendingBytes).toBe(300 * KiB);
  });

  it("takes one paste far past the budget and refuses one past the hard cap", () => {
    const failed = vi.fn();
    const refused = vi.fn();
    const writer = new BoundedPtyWriter(failed, refused);
    expect(writer.enqueue(new Uint8Array(2 * KiB * KiB))).toBe(true);
    expect(writer.enqueue(new Uint8Array(9 * KiB * KiB))).toBe(false);
    expect(refused).toHaveBeenCalledWith("input-too-large");
    expect(failed).not.toHaveBeenCalled();
    expect(writer.enqueue(Uint8Array.of(1))).toBe(false);
    expect(writer.hasFailed).toBe(false);
  });

  it("keeps typing alive after a reply is refused", async () => {
    const failed = vi.fn();
    const writer = new BoundedPtyWriter(failed);
    writer.enqueue(new Uint8Array(250 * KiB), true);
    expect(writer.enqueue(new Uint8Array(40 * KiB * KiB), true)).toBe(true);
    expect(writer.enqueue(new Uint8Array(1), true)).toBe(false);
    expect(writer.enqueue(Uint8Array.of(7))).toBe(true);
    expect(failed).not.toHaveBeenCalled();
    expect(writer.hasFailed).toBe(false);
    // Larger than any answer the core makes: refused, typing still alive.
    expect(
      new BoundedPtyWriter(() => undefined).enqueue(new Uint8Array(65 * KiB * KiB), true),
    ).toBe(false);
  });

  it("drops a reserved slot past the action cap instead of failing", () => {
    const failed = vi.fn();
    const refused = vi.fn();
    const writer = new BoundedPtyWriter(failed, refused);
    for (let index = 0; index < 256; index++) expect(writer.reserveInput()).not.toBeNull();
    expect(writer.reserveInput()).toBeNull();
    expect(writer.deferInput(() => undefined)).toBe(true);
    expect(refused).toHaveBeenCalledWith("actions-full");
    expect(failed).not.toHaveBeenCalled();
    expect(writer.hasFailed).toBe(false);
  });

  it("coalesces held-key repeats behind a reserved slot", () => {
    const refused = vi.fn();
    const writer = new BoundedPtyWriter(() => undefined, refused);
    writer.reserveInput();
    const kept = vi.fn();
    for (let index = 0; index < 100; index++) expect(writer.deferInput(kept, 2, true)).toBe(true);
    // Reserved: the first slot plus the repeats taken before the limit.
    for (let index = 0; index < 5; index++) expect(writer.deferInput(kept, 2, false)).toBe(true);
    expect(refused).not.toHaveBeenCalled();
    expect(writer.pendingActions).toBe(32 + 5);
  });

  it("releases a reserved slot nobody resolved so typing flows again", async () => {
    vi.useFakeTimers();
    try {
      const refused = vi.fn();
      const { pty, writes } = stalledPty();
      const writer = new BoundedPtyWriter(() => undefined, refused);
      writer.attach(pty);
      const slot = writer.reserveInput();
      expect(slot).not.toBeNull();
      writer.enqueue(Uint8Array.of(1));
      await vi.advanceTimersByTimeAsync(1000);
      expect(writes.length).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refused).toHaveBeenCalledWith("slot-timeout");
      expect(writes.length).toBe(1);
      const late = vi.fn();
      slot?.(late);
      expect(late).not.toHaveBeenCalled();
      expect(writer.holdingInput).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a slot whose input no longer fits and keeps the writer alive", () => {
    const failed = vi.fn();
    const refused = vi.fn();
    const writer = new BoundedPtyWriter(failed, refused);
    const slot = writer.reserveInput();
    const action = vi.fn();
    slot?.(action, 9 * KiB * KiB);
    expect(refused).toHaveBeenCalledWith("input-too-large");
    expect(action).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(writer.holdingInput).toBe(false);
    expect(writer.enqueue(Uint8Array.of(1))).toBe(true);
  });

  it("stops after a failed write instead of sending later input", async () => {
    let reject!: (error: Error) => void;
    const write = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    const failed = vi.fn();
    const writer = new BoundedPtyWriter(failed);
    const pty = { id: 1, write, close: vi.fn(), resize: vi.fn() } as PtySession;
    writer.attach(pty);
    writer.enqueue(Uint8Array.of(1));
    writer.enqueue(Uint8Array.of(2));
    reject(new Error("write failed"));
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(write).toHaveBeenCalledTimes(1);
    expect(writer.pendingBytes).toBe(0);
    expect(writer.enqueue(Uint8Array.of(3))).toBe(false);
  });

  it("does not let an old PTY failure stop its replacement", async () => {
    let reject!: (error: Error) => void;
    const old: PtySession = {
      id: 1,
      write: () => new Promise<void>((_, fail) => { reject = fail; }),
      close: async () => {},
      resize: async () => {},
    };
    const nextWrite = vi.fn(async () => {});
    const next = { id: 2, write: nextWrite } as unknown as PtySession;
    const failed = vi.fn();
    const writer = new BoundedPtyWriter(failed);
    writer.attach(old);
    writer.enqueue(Uint8Array.of(1));
    writer.detach();
    writer.clear();
    writer.attach(next);
    writer.enqueue(Uint8Array.of(2));
    reject(new Error("old PTY closed"));
    await vi.waitFor(() => expect(nextWrite).toHaveBeenCalledOnce());
    expect(failed).not.toHaveBeenCalled();
  });

  it("writes in order, one write in flight, a large reply unbatched", async () => {
    const { pty, writes, release } = stalledPty();
    const writer = new BoundedPtyWriter(() => undefined);
    writer.enqueue(Uint8Array.of(1));
    writer.attach(pty);
    // Waits compare counts: a failed check on `writes` itself would format
    // the 1 MiB answer into its message on every poll.
    await vi.waitFor(() => expect(writes.length).toBe(1));
    writer.enqueue(Uint8Array.of(2));
    const answer = new Uint8Array(1024 * KiB).fill(7);
    writer.enqueue(answer, true);
    writer.enqueue(Uint8Array.of(3));
    expect(writes.length).toBe(1);

    release();
    await vi.waitFor(() => expect(writes.length).toBe(2));
    expect([...writes[1]]).toEqual([2]);
    release();
    await vi.waitFor(() => expect(writes.length).toBe(3));
    expect(writes[2]).toBe(answer);
    release();
    await vi.waitFor(() => expect(writes.length).toBe(4));
    expect([...writes[3]]).toEqual([3]);
    expect(writer.pendingBytes).toBe(0);
    release();
    // Budgets are freed as writes are taken.
    expect(writer.enqueue(new Uint8Array(40 * KiB * KiB), true)).toBe(true);
  });

  it("settles a write once the PTY took it, or false when it is dropped", async () => {
    const { pty, release } = stalledPty();
    const writer = new BoundedPtyWriter(() => undefined);
    writer.attach(pty);
    const done = vi.fn();
    writer.enqueue(Uint8Array.of(1), false, () => true, undefined, done);
    await vi.waitFor(() => expect(pty.write).toHaveBeenCalled());
    expect(done).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(true));
    const dropped = vi.fn();
    writer.enqueue(Uint8Array.of(2), false, () => false, undefined, dropped);
    await vi.waitFor(() => expect(dropped).toHaveBeenCalledWith(false));
    const cleared = vi.fn();
    writer.detach();
    writer.enqueue(Uint8Array.of(3), false, undefined, undefined, cleared);
    writer.clear();
    expect(cleared).toHaveBeenCalledWith(false);
  });

  it("stays failed after a real write error until detached", async () => {
    const failed = vi.fn();
    const writer = new BoundedPtyWriter(failed);
    writer.attach({
      id: 1, write: async () => { throw new Error("EIO"); },
      close: async () => undefined, resize: async () => undefined,
    });
    writer.enqueue(Uint8Array.of(1));
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(writer.hasFailed).toBe(true);
    expect(writer.enqueue(Uint8Array.of(2))).toBe(false);
    writer.detach();
    expect(writer.hasFailed).toBe(false);
  });
});
