import { toast } from "sonner";
import type { BoundedPtyWriter } from "./BoundedPtyWriter";

export function reportTerminalInputFailure(leafId: number, error: unknown): void {
  console.error("[oarlock] Ghostty PTY write failed:", error);
  toast.error("Terminal input stopped", {
    id: `terminal-input-${leafId}`,
    duration: Number.POSITIVE_INFINITY,
    description: "Some input may be incomplete. Restart this terminal before continuing.",
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
