import { afterEach, expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  page: vi.fn(async () => "page"),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: ipc.invoke,
  isTauri: () => true,
}));
vi.mock("@/lib/networkPage", () => ({ networkPage: ipc.page }));
import {
  decodeClipboardSnapshot,
  invalidateClipboardImage,
  readTerminalClipboardSnapshot,
} from "./terminalClipboardSnapshot";
function wire(
  revision: string,
  image = "empty",
  bytes: number[] = [],
  text: string | null = "text",
  focusRequired = false,
): ArrayBuffer {
  const header = new TextEncoder().encode(
    JSON.stringify({ revision, image, text, focusRequired }),
  );
  const out = new Uint8Array(4 + header.length + bytes.length);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  out.set(bytes, 4 + header.length);
  return out.buffer;
}
afterEach(() => {
  invalidateClipboardImage();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("checks native identity on every cache reuse and releases bytes after one second", async () => {
  vi.useFakeTimers();
  ipc.invoke.mockResolvedValueOnce(wire("a", "png", [1]));
  const first = await readTerminalClipboardSnapshot("always");
  ipc.invoke.mockResolvedValueOnce(wire("a", "reuse"));
  expect((await readTerminalClipboardSnapshot("always")).image).toBe(
    first.image,
  );
  expect(ipc.invoke).toHaveBeenLastCalledWith(
    "terminal_clipboard_snapshot",
    expect.objectContaining({ knownImageRevision: "a" }),
  );
  await vi.advanceTimersByTimeAsync(1001);
  ipc.invoke.mockResolvedValueOnce(wire("b", "empty"));
  expect((await readTerminalClipboardSnapshot("always")).image).toBeNull();
  expect(ipc.invoke).toHaveBeenLastCalledWith(
    "terminal_clipboard_snapshot",
    expect.objectContaining({ knownImageRevision: null }),
  );
});
it("keeps one image capture in flight and verifies its version for queued reads", async () => {
  let finish!: (buffer: ArrayBuffer) => void;
  ipc.invoke.mockImplementationOnce(
    () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
  );
  const first = readTerminalClipboardSnapshot("always");
  await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledOnce());
  const second = readTerminalClipboardSnapshot("always");
  await Promise.resolve();
  expect(ipc.invoke).toHaveBeenCalledOnce();
  ipc.invoke.mockResolvedValueOnce(wire("new", "empty"));
  finish(wire("old", "png", [1]));
  await first;
  expect((await second).image).toBeNull();
  expect(ipc.invoke).toHaveBeenLastCalledWith(
    "terminal_clipboard_snapshot",
    expect.objectContaining({ knownImageRevision: "old" }),
  );
});
it("rejects changed captures rather than returning cached bytes", async () => {
  ipc.invoke.mockResolvedValueOnce(wire("a", "png", [1]));
  await readTerminalClipboardSnapshot("always");
  ipc.invoke.mockRejectedValueOnce(new Error("Clipboard changed"));
  await expect(readTerminalClipboardSnapshot("always")).rejects.toThrow(
    "Clipboard changed",
  );
});
it("drops an aborted capture and does not cache its image", async () => {
  let finish!: (buffer: ArrayBuffer) => void;
  ipc.invoke.mockImplementationOnce(
    () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
  );
  const owner = new AbortController();
  const read = readTerminalClipboardSnapshot("always", false, owner.signal);
  const rejected = expect(read).rejects.toThrow();
  await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledOnce());
  owner.abort();
  finish(wire("a", "png", [1]));
  await rejected;
  ipc.invoke.mockResolvedValueOnce(wire("b", "empty"));
  await readTerminalClipboardSnapshot("always");
  expect(ipc.invoke).toHaveBeenLastCalledWith(
    "terminal_clipboard_snapshot",
    expect.objectContaining({ knownImageRevision: null }),
  );
});
it("rejects malformed frames and reuse without the exact cached revision", () => {
  for (const frame of [
    new ArrayBuffer(2),
    Uint8Array.of(100, 0, 0, 0).buffer,
    wire("a", "png"),
    wire("a", "empty", [1]),
    wire("a", "reuse"),
    wire("a", "unknown"),
  ]) {
    expect(() => decodeClipboardSnapshot(frame, null)).toThrow();
  }
  expect(() =>
    decodeClipboardSnapshot(wire("b", "reuse"), {
      revision: "a",
      at: 0,
      image: Uint8Array.of(1),
    }),
  ).toThrow("version mismatch");
});

it.each([true, false])(
  "applies the focus barrier only when native requires it (%s)",
  async (required) => {
    const target = new EventTarget();
    const remove = vi.spyOn(target, "removeEventListener");
    vi.stubGlobal("window", target);
    let focused = true;
    vi.stubGlobal("document", { hasFocus: () => focused });
    let finish!: (value: ArrayBuffer) => void;
    ipc.invoke.mockImplementationOnce(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve;
        }),
    );
    const result = readTerminalClipboardSnapshot("always");
    const assertion = required
      ? expect(result).rejects.toThrow("focus changed")
      : expect(result).resolves.toMatchObject({ revision: "1" });
    await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledOnce());
    focused = false;
    target.dispatchEvent(new Event("blur"));
    focused = true;
    finish(wire("1", "png", [1], "old", required));
    await assertion;
    expect(remove).toHaveBeenCalledOnce();
  },
);
