import { expect, it, vi } from "vitest";
import { BoundedPtyWriter } from "./BoundedPtyWriter";
import { scheduleOwnedInput } from "./orderedAppInput";
import type { PtySession } from "./pty-bridge";

it("cancels a delayed cd when its terminal context changes", async () => {
  const sent: string[] = [];
  const writer = new BoundedPtyWriter((error) => { throw error; });
  writer.attach({ id: 1, write: async (bytes: Uint8Array) => {
    sent.push(new TextDecoder().decode(bytes));
  }, close: async () => {}, resize: async () => {} } as PtySession);
  let current = true;
  let finish!: (value: string) => void;
  const cancelled = vi.fn();
  const prepare = () => new Promise<string>((resolve) => { finish = resolve; });
  expect(scheduleOwnedInput(writer, { active: () => current }, prepare, () => true,
    (data, valid) => writer.enqueue(new TextEncoder().encode(data), false, valid),
    cancelled, vi.fn())).toBe(true);
  await Promise.resolve();
  current = false;
  finish("cd /repo\r");
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  expect(sent).toEqual([]);
  writer.dispose();
});

it("rechecks context when a later app write reaches the queue", async () => {
  const sent: string[] = [];
  const cancelled = vi.fn();
  const writer = new BoundedPtyWriter((error) => { throw error; });
  writer.attach({ id: 1, write: async (bytes: Uint8Array) => {
    sent.push(new TextDecoder().decode(bytes));
  }, close: async () => {}, resize: async () => {} } as PtySession);
  const paste = writer.reserveInput();
  if (!paste) throw new Error("Could not reserve input");
  let current = true;
  writer.enqueue(new TextEncoder().encode("app input"), false, () => current, cancelled);
  current = false;
  paste(() => writer.enqueue(new TextEncoder().encode("paste")));
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  expect(sent).toEqual(["paste"]);
  writer.dispose();
});
