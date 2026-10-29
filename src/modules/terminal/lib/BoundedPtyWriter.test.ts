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
  it("refuses input past its budget while the PTY is not reading", () => {
    const failed = vi.fn();
    const writer = new BoundedPtyWriter(failed);
    expect(writer.enqueue(new Uint8Array(200 * KiB))).toBe(true);
    expect(writer.enqueue(new Uint8Array(100 * KiB))).toBe(false);
    expect(writer.enqueue(new Uint8Array(56 * KiB))).toBe(false);
    expect(writer.pendingBytes).toBe(0);
    expect(failed).toHaveBeenCalledOnce();
  });

  it("takes a large reply the program asked for once, then refuses more replies", () => {
    const writer = new BoundedPtyWriter(() => undefined);
    writer.enqueue(new Uint8Array(250 * KiB));
    // A clipboard answer far past the budget goes through.
    expect(writer.enqueue(new Uint8Array(40 * KiB * KiB), true)).toBe(true);
    // With that backlog no more replies are taken; typing still is.
    expect(writer.enqueue(new Uint8Array(6 * KiB))).toBe(true);
    expect(writer.pendingBytes).toBe(256 * KiB + 40 * KiB * KiB);
    expect(writer.enqueue(new Uint8Array(1), true)).toBe(false);
    expect(writer.enqueue(new Uint8Array(1))).toBe(false);
    // Larger than any answer the core makes: refused.
    expect(
      new BoundedPtyWriter(() => undefined).enqueue(
        new Uint8Array(65 * KiB * KiB),
        true,
      ),
    ).toBe(false);
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
});
