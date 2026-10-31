import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn(), page: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  isTauri: () => true,
}));
vi.mock("./networkPage", () => ({ networkPage: native.page }));
import { ClipboardWrite, installClipboardCopyBarrier } from "./clipboardWrite";

beforeEach(() => {
  native.invoke.mockReset();
  native.page.mockReset().mockResolvedValue("p1");
  native.invoke.mockImplementation(async (name) =>
    name === "clipboard_write_begin" ? "t1" : undefined,
  );
});
afterEach(() => vi.unstubAllGlobals());

it("cancels a reservation whose reply arrives after terminal disposal", async () => {
  let finish!: (value: string) => void;
  native.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const owner = new AbortController();
  const write = new ClipboardWrite(false, owner.signal);
  write.prepare();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  owner.abort();
  finish("old-ticket");
  await expect(write.text("private")).rejects.toThrow();
  await vi.waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("clipboard_write_cancel", {
      pageGeneration: "p1",
      ticket: "old-ticket",
    }),
  );
  expect(
    native.invoke.mock.calls.some(([name]) => name === "clipboard_text_write"),
  ).toBe(false);
});

it("does not admit a cancelled request after page initialization", async () => {
  let finish!: (value: string) => void;
  native.page.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const owner = new AbortController();
  const write = new ClipboardWrite(false, owner.signal);
  write.prepare();
  owner.abort();
  finish("p1");
  await expect(write.check()).rejects.toThrow();
  expect(native.invoke).not.toHaveBeenCalled();
});

it("keeps the original page token through native image commit", async () => {
  const write = new ClipboardWrite();
  write.prepare();
  await write.check();
  native.page.mockResolvedValue("replacement");
  const png = Uint8Array.of(1);
  await write.image(png);
  write.dispose();
  expect(native.invoke).toHaveBeenCalledWith("clipboard_image_write", png, {
    headers: {
      "x-page-generation": "p1",
      "x-clipboard-ticket": "t1",
    },
  });
  expect(
    native.invoke.mock.calls.some(
      ([name]) => name === "clipboard_write_cancel",
    ),
  ).toBe(false);
});

it("preserves intent order even when reservations are prepared in reverse", async () => {
  const first = new ClipboardWrite();
  const second = new ClipboardWrite();
  second.prepare();
  first.prepare();
  await Promise.all([first.check(), second.check()]);
  const calls = native.invoke.mock.calls.filter(
    ([name]) => name === "clipboard_write_begin",
  );
  expect(calls[0][1].sequence).toBeGreaterThan(calls[1][1].sequence);
  first.dispose();
  second.dispose();
});

it("announces browser/menu Copy and Cut without replacing their native formats", async () => {
  const handlers = new Map<string, () => void>();
  vi.stubGlobal("document", {
    addEventListener: (name: string, fn: () => void) => handlers.set(name, fn),
  });
  installClipboardCopyBarrier();
  handlers.get("copy")?.();
  await vi.waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("clipboard_write_cancel", {
      pageGeneration: "p1",
      ticket: "t1",
    }),
  );
  handlers.get("cut")?.();
  await vi.waitFor(() =>
    expect(
      native.invoke.mock.calls.filter(
        ([name]) => name === "clipboard_write_begin",
      ),
    ).toHaveLength(2),
  );
  expect(
    native.invoke.mock.calls.some(([name]) => name === "clipboard_text_write"),
  ).toBe(false);
});
