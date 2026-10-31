import { requireCurrentPreferences } from "@/modules/settings/readiness";
import { toast } from "sonner";

/** Refused admission leaves the approval unanswered and its original lease owned. */
export function answerApproval(
  respond: (answer: {
    id: string;
    approved: boolean;
  }) => void | PromiseLike<void>,
  id: string,
  approved: boolean,
): void | PromiseLike<void> {
  try {
    requireCurrentPreferences();
  } catch (error) {
    toast.error("Could not continue chat", { description: String(error) });
    return;
  }
  return respond({ id, approved });
}
