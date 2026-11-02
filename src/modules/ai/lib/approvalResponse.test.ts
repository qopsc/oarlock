import { expect, it, vi } from "vitest";
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
import { usePreferencesStore } from "@/modules/settings/preferences";
import { answerApproval } from "./approvalResponse";
it.each([true, false])(
  "keeps an approval unanswered until an explicit retry with current preferences: %s",
  (approved) => {
    const respond = vi.fn();
    usePreferencesStore.setState({
      hydrated: true,
      error: "read failed",
      syncing: false,
    });
    answerApproval(respond, "approval", approved);
    expect(respond).not.toHaveBeenCalled();
    usePreferencesStore.setState({ error: null });
    expect(respond).not.toHaveBeenCalled();
    answerApproval(respond, "approval", approved);
    expect(respond).toHaveBeenCalledExactlyOnceWith({
      id: "approval",
      approved,
    });
  },
);
