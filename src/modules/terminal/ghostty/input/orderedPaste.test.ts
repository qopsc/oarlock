import { expect, it, vi } from "vitest";
import type { GhosttyTerminalModelApi } from "@/modules/terminal/ghostty/GhosttyTerminalModel";
import { BoundedPtyWriter } from "@/modules/terminal/lib/BoundedPtyWriter";
import type { PtySession } from "@/modules/terminal/lib/pty-bridge";
import { FakeElement, FakeTextArea } from "./fakeTextArea";
import { GhosttyInputController } from "./GhosttyInputController";

const clipboard = vi.hoisted(() => ({ pending: Promise.resolve("") }));
vi.mock("@/modules/terminal/lib/terminalClipboard", () => ({
  readTerminalClipboardSnapshot: async () => ({
    revision: "1", text: await clipboard.pending, image: null,
  }),
}));
const key = (values: Partial<KeyboardEvent>) => Object.assign(
  new Event("keydown", { bubbles: true, cancelable: true }),
  { altKey: false, code: "", ctrlKey: false, getModifierState: () => false,
    isComposing: false, key: "", keyCode: 0, metaKey: false, repeat: false,
    shiftKey: false, ...values },
) as KeyboardEvent;
function setup(extra: Partial<ConstructorParameters<typeof GhosttyInputController>[0]> = {}) {
  const input = new FakeTextArea();
  const sent: string[] = [];
  const writer = new BoundedPtyWriter((error) => { throw error; });
  writer.attach({ id: 1, write: async (bytes: Uint8Array) => {
    sent.push(new TextDecoder().decode(bytes));
  }, close: async () => {}, resize: async () => {} } as PtySession);
  const model = {
    cols: 80, rows: 24,
    modes: () => ({ alternateScreen: false, bracketedPaste: false, focusReporting: false, mouseTracking: false, synchronizedOutput: false }),
    mode: () => false, scrollToBottom: () => false,
    encodeKey: () => Uint8Array.of(13),
  } as unknown as GhosttyTerminalModelApi;
  const controller = new GhosttyInputController({
    model, input: input as unknown as HTMLTextAreaElement,
    pointerTarget: new FakeElement() as unknown as HTMLElement,
    cellSize: () => ({ width: 10, height: 20 }), isMac: true,
    onCopy: () => false, onData: (bytes) => { writer.enqueue(bytes); },
    reserveInput: () => writer.reserveInput(),
    deferInput: (action) => writer.deferInput(action),
    ...extra,
  });
  return { input, writer, sent, controller };
}
function delayedClipboard() {
  let finish!: (value: string) => void;
  clipboard.pending = new Promise((resolve) => { finish = resolve; });
  return finish;
}

it("delivers a delayed paste before Enter", async () => {
  const finish = delayedClipboard();
  const { input, sent, writer, controller } = setup();
  input.dispatchEvent(key({ key: "v", code: "KeyV", metaKey: true }));
  input.dispatchEvent(key({ key: "Enter", code: "Enter" }));
  expect(sent).toEqual([]);
  finish("echo hello");
  await vi.waitFor(() => expect(sent).toEqual(["echo hello", "\r"]));
  controller.dispose(); writer.dispose();
});

it("orders command-bar text and Enter behind the pending paste", async () => {
  const finish = delayedClipboard();
  let draft = "";
  const submitted: string[] = [];
  const { input, writer, controller } = setup({
    onPaste: (text) => { draft += text; return true; },
    onText: (text) => { draft += text; return true; },
    onKeyDown: (event) => {
      if (event.key !== "Enter") return false;
      submitted.push(draft); return true;
    },
  });
  input.dispatchEvent(key({ key: "v", code: "KeyV", metaKey: true }));
  input.dispatchEvent(key({ key: "x", code: "KeyX" }));
  input.dispatchEvent(key({ key: "Enter", code: "Enter" }));
  expect(submitted).toEqual([]);
  finish("echo ");
  await vi.waitFor(() => expect(submitted).toEqual(["echo x"]));
  controller.dispose(); writer.dispose();
});

it("holds later input through paste confirmation", async () => {
  let answer!: (value: boolean) => void;
  const { input, sent, writer, controller } = setup({
    confirmPaste: () => new Promise((resolve) => { answer = resolve; }),
  });
  controller.paste("echo one\necho two");
  input.dispatchEvent(key({ key: "Enter", code: "Enter" }));
  expect(sent).toEqual([]);
  await Promise.resolve();
  answer(true);
  await vi.waitFor(() => expect(sent).toEqual(["echo one\recho two", "\r"]));
  controller.dispose(); writer.dispose();
});

it("keeps multiple clipboard reads in request order even when they finish backwards", async () => {
  const first = delayedClipboard();
  const { input, sent, writer, controller } = setup();
  input.dispatchEvent(key({ key: "v", code: "KeyV", metaKey: true }));
  const second = delayedClipboard();
  input.dispatchEvent(key({ key: "v", code: "KeyV", metaKey: true }));
  second("second");
  await Promise.resolve();
  expect(sent).toEqual([]);
  first("first");
  await vi.waitFor(() => expect(sent).toEqual(["first", "second"]));
  controller.dispose(); writer.dispose();
});

it("cancels a context-bound app write when its context changes behind a paste", async () => {
  const finish = delayedClipboard();
  const { input, sent, writer, controller } = setup();
  let current = true;
  input.dispatchEvent(key({ key: "v", code: "KeyV", metaKey: true }));
  writer.enqueue(new TextEncoder().encode("cd /other\r"), false, () => current);
  current = false;
  finish("paste");
  await vi.waitFor(() => expect(sent).toEqual(["paste"]));
  controller.dispose(); writer.dispose();
});

it("drops unresolved paste and later input when the terminal closes", async () => {
  const finish = delayedClipboard();
  const { input, sent, writer, controller } = setup();
  input.dispatchEvent(key({ key: "v", code: "KeyV", metaKey: true }));
  input.dispatchEvent(key({ key: "Enter", code: "Enter" }));
  controller.dispose(); writer.dispose();
  finish("late");
  await Promise.resolve(); await Promise.resolve();
  expect(sent).toEqual([]);
});
