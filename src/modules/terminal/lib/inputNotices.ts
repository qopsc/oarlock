import { toast } from "sonner";
import type { BoundedPtyWriter, InputRefusal } from "./BoundedPtyWriter";

export function reportTerminalInputFailure(leafId: number, error: unknown): void {
  console.error("[oarlock] Ghostty PTY write failed:", error);
  toast.error("Terminal input stopped", {
    id: `terminal-input-${leafId}`,
    duration: Number.POSITIVE_INFINITY,
    description: "Some input may be incomplete. Restart this terminal before continuing.",
  });
}

const REFUSAL_TEXT: Readonly<Record<InputRefusal, string>> = {
  "input-full": "The program is not reading its input, so this was not sent.",
  "input-too-large": "That is more than a terminal can be sent at once (8 MiB), so it was not sent.",
  "actions-full": "Too much input is waiting on a clipboard read, so this was not sent.",
  "slot-timeout": "A paste or clipboard read took too long, so it was not sent.",
};

/** Input dropped for a bound; the terminal keeps working. */
export function reportTerminalInputRefused(leafId: number, reason: InputRefusal): void {
  toast.message("Terminal input not sent", {
    id: `terminal-input-refused-${leafId}`,
    description: REFUSAL_TEXT[reason],
  });
}

export function reportPendingInputCancellation(
  writer: BoundedPtyWriter,
  reason: "closed" | "restarted",
): void {
  if (!writer.hasPendingInput) return;
  toast.message("Pending terminal input cancelled", {
    description: `The terminal was ${reason} before input could be sent.`,
  });
}
