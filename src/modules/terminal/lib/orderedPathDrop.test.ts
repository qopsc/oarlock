import { expect, it, vi } from "vitest";
import type { PtySession } from "./pty-bridge";
import { BoundedPtyWriter } from "./BoundedPtyWriter";
import { prepareShellPathDrop } from "./shellPathDrop";

it("releases the input queue when a pending path drop loses its owner", async () => {
  const sent: string[] = [];
  const writer = new BoundedPtyWriter((error) => { throw error; });
  writer.attach({ id: 1, write: async (bytes: Uint8Array) => {
    sent.push(new TextDecoder().decode(bytes));
  }, close: async () => {}, resize: async () => {} } as PtySession);
  const finish = writer.reserveInput();
  if (!finish) throw new Error("Could not reserve input");
  let active = true;
  let resolve!: (value: { shell: "posix"; paths: string[] }) => void;
  const prepared = new Promise<{ shell: "posix"; paths: string[] }>((done) => { resolve = done; });
  const cancelled = vi.fn();
  const drop = prepareShellPathDrop(1, ["/repo"], { kind: "local" }, () => active,
    (text) => finish(() => writer.enqueue(new TextEncoder().encode(text)), text.length * 2),
    () => prepared,
  ).then(() => finish(cancelled));
  writer.enqueue(new TextEncoder().encode("next"));
  active = false;
  resolve({ shell: "posix", paths: ["/repo"] });
  await drop;
  await vi.waitFor(() => expect(sent).toEqual(["next"]));
  expect(cancelled).toHaveBeenCalledOnce();
  writer.dispose();
});
