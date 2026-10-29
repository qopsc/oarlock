import { expect, it } from "vitest";
import { TerminalRequestLifetime } from "./TerminalRequestLifetime";
import {
  requestTerminalPrompt,
  useTerminalPromptStore,
} from "./terminalPrompts";

it("revokes reads on every permission change while retaining the terminal generation", async () => {
  const lifetime = new TerminalRequestLifetime();
  const first = lifetime.clipboardSignal;
  const pending = requestTerminalPrompt({ kind: "clipboard-read" }, first);
  lifetime.cancelReads();
  await expect(pending).resolves.toBe("deny");
  expect(useTerminalPromptStore.getState().queue).toHaveLength(0);
  const second = lifetime.clipboardSignal;
  expect(first.aborted).toBe(true);
  expect(second.aborted).toBe(false);
  expect(lifetime.signal.aborted).toBe(false);
  lifetime.cancelReads();
  expect(second.aborted).toBe(true);
  expect(first.aborted).toBe(true);
  lifetime.dispose();
  lifetime.cancelReads();
  expect(lifetime.signal.aborted).toBe(true);
  expect(lifetime.clipboardSignal.aborted).toBe(true);
});

it("cancels paste prompts and clipboard prompts together when their terminal ends", async () => {
  const lifetime = new TerminalRequestLifetime();
  const paste = requestTerminalPrompt(
    { kind: "paste", text: "ls\n" },
    lifetime.signal,
  );
  const read = requestTerminalPrompt(
    { kind: "clipboard-read" },
    lifetime.clipboardSignal,
  );
  lifetime.dispose();
  await expect(Promise.all([paste, read])).resolves.toEqual(["deny", "deny"]);
  expect(useTerminalPromptStore.getState().queue).toHaveLength(0);
});

it("keeps a program's final clipboard write alive after shell exit until the terminal closes", () => {
  const lifetime = new TerminalRequestLifetime();
  const write = lifetime.programSignal;
  lifetime.endInput();
  expect(lifetime.signal.aborted).toBe(true);
  expect(write.aborted).toBe(false);
  lifetime.dispose();
  expect(write.aborted).toBe(true);
  expect(lifetime.programSignal.aborted).toBe(true);
});
