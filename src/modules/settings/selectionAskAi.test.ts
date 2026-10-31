import { expect, it, vi } from "vitest";
const mutate = vi.hoisted(() => vi.fn());
vi.mock("./nativePreferences", () => ({ mutatePreferences: mutate }));
import {
  parsePreferences,
  coerceSelectionAskAi,
  setSelectionAskAi,
} from "./store";
it("selection Ask AI stays enabled unless explicitly disabled", () => {
  for (const value of [undefined, true, "false", 0, null]) {
    expect(coerceSelectionAskAi(value)).toBe(true);
    expect(parsePreferences({ selectionAskAi: value }).selectionAskAi).toBe(
      true,
    );
  }
  expect(parsePreferences({ selectionAskAi: false }).selectionAskAi).toBe(
    false,
  );
});
it("persists the selection preference through native ownership", async () => {
  await setSelectionAskAi(false);
  expect(mutate).toHaveBeenCalledWith({
    kind: "set",
    key: "selectionAskAi",
    value: false,
  });
});
