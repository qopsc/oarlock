import { expect, it } from "vitest";
import type { GhosttyTerminalModelApi } from "@/modules/terminal/ghostty/GhosttyTerminalModel";
import { FakeElement, FakeTextArea } from "@/modules/terminal/ghostty/input/fakeTextArea";
import { GhosttyInputController } from "@/modules/terminal/ghostty/input/GhosttyInputController";
import { BoundedPtyWriter } from "./BoundedPtyWriter";
import type { PtySession } from "./pty-bridge";
import type { DropShell } from "./quoteShellPath";
import { runShellDrop } from "./shellPathDrop";

function terminal(bracketedPaste: boolean) {
  const sent: string[] = [];
  const writer = new BoundedPtyWriter((error) => { throw error; });
  writer.attach({ id: 1, write: async (bytes: Uint8Array) => {
    sent.push(new TextDecoder().decode(bytes));
  }, close: async () => {}, resize: async () => {} } as PtySession);
  const model = {
    cols: 80, rows: 24,
    modes: () => ({ alternateScreen: false, bracketedPaste, focusReporting: false, mouseTracking: false, synchronizedOutput: false }),
    mode: () => false, scrollToBottom: () => false,
    encodeKey: () => Uint8Array.of(13),
  } as unknown as GhosttyTerminalModelApi;
  const controller = new GhosttyInputController({
    model, input: new FakeTextArea() as unknown as HTMLTextAreaElement,
    pointerTarget: new FakeElement() as unknown as HTMLElement,
    cellSize: () => ({ width: 10, height: 20 }), isMac: true,
    onCopy: () => false, onData: (bytes) => { writer.enqueue(bytes); },
    reserveInput: (options) => writer.reserveInput(options),
    deferInput: (action, size, repeat) => writer.deferInput(action, size, repeat),
  });
  return { sent, writer, controller };
}

async function drop(
  dialect: DropShell,
  paths: string[],
  bracketed: boolean,
): Promise<string[]> {
  const { sent, writer, controller } = terminal(bracketed);
  const finish = writer.reserveInput();
  if (!finish) throw new Error("no slot");
  await runShellDrop({
    paths, source: { kind: "local" }, target: { kind: "local" }, windows: false,
    finish, atPrompt: async () => true, dialect: async () => dialect,
    promptConfirmed: () => true, active: () => true, running: () => false,
    paste: (text) => controller.paste(text), refuse: () => { throw new Error("refused"); },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.dispose();
  writer.dispose();
  return sent;
}

it.each([
  ["posix", "'/a b' '/it'\\''s' "],
  ["fish", "'/a b' '/it\\'s' "],
  ["powershell", "'/a b' '/it''s' "],
] as const)("a %s drop reaches the PTY as one bracketed paste", async (dialect, quoted) => {
  expect(await drop(dialect, ["/a b", "/it's"], true)).toEqual([`\x1b[200~${quoted}\x1b[201~`]);
});

it("a cmd drop reaches the PTY quoted for cmd", async () => {
  expect(await drop("cmd", ["C:\\a b"], true)).toEqual(['\x1b[200~"C:\\a b" \x1b[201~']);
});

it("pastes plain text when the program did not enable bracketed paste", async () => {
  expect(await drop("posix", ["/a b"], false)).toEqual(["'/a b' "]);
});
