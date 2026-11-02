import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { OarlockGhostty } from "@oarlock/ghostty-core/adapted";
import { AdaptedGhosttyTerminalModel } from "../../src/modules/terminal/ghostty/AdaptedGhosttyTerminalModel.ts";
import { GhosttyInputController } from "../../src/modules/terminal/ghostty/input/GhosttyInputController.ts";
import {
  FakeTextArea,
  FakeElement,
} from "../../src/modules/terminal/ghostty/input/fakeTextArea.ts";
const bytes = await readFile(
  new URL(
    "../../packages/ghostty-core/adapted/ghostty-vt.wasm",
    import.meta.url,
  ),
);
const core = await OarlockGhostty.loadBytes(Uint8Array.from(bytes).buffer);
const model = new AdaptedGhosttyTerminalModel(core, {
  backend: "ghostty-webgpu",
  cols: 80,
  rows: 24,
  onReply: (bytes) =>
    process.stdout.write(
      JSON.stringify({ bytes: Buffer.from(bytes).toString("base64") }) + "\n",
    ),
});

const input = new FakeTextArea();
const controller = new GhosttyInputController({
  model,
  input: input as unknown as HTMLTextAreaElement,
  pointerTarget: new FakeElement() as unknown as HTMLElement,
  cellSize: () => ({ width: 10, height: 20 }),
  isMac: true,
  onCopy: () => false,
  onData: (bytes) =>
    process.stdout.write(
      JSON.stringify({ bytes: Buffer.from(bytes).toString("base64") }) + "\n",
    ),
});
const chars: Record<string, [string, boolean]> = {
  ":": ["Semicolon", true],
  ";": ["Semicolon", false],
  "/": ["Slash", false],
  "?": ["Slash", true],
  " ": ["Space", false],
  "\n": ["Enter", false],
  "\x1b": ["Escape", false],
  "!": ["Digit1", true],
  "%": ["Digit5", true],
  $: ["Digit4", true],
  ".": ["Period", false],
};
function type(keys: string) {
  for (const key of keys) {
    const [code, shiftKey] = chars[key] ?? [
      /^[a-z]$/i.test(key) ? "Key" + key.toUpperCase() : "Digit" + key,
      /^[A-Z]$/.test(key),
    ];
    input.dispatchEvent(
      Object.assign(new Event("keydown", { cancelable: true }), {
        key: key === "\n" ? "Enter" : key === "\x1b" ? "Escape" : key,
        code,
        shiftKey,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        repeat: false,
        isComposing: false,
        keyCode: 0,
        getModifierState: () => false,
      }),
    );
  }
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.bytes)
    model.write(Uint8Array.from(Buffer.from(request.bytes, "base64")));
  if (request.keys) type(request.keys);
}
controller.dispose();
model.dispose();
