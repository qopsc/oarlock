import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  mutate: vi.fn(),
}));
vi.mock("./nativePreferences", () => ({
  readNativePreferences: async () => ({ revision: 0, values: fake.values }),
  mutatePreferences: fake.mutate,
}));
vi.mock("./endpoints", () => ({ loadCustomEndpoints: async () => [] }));
import {
  loadPreferences,
  setAiStopBackgroundJobs,
  setAiStopSubagents,
  setAiAllowUnmanagedJobs,
} from "./store";
beforeEach(() => {
  fake.values = {};
  fake.mutate.mockReset().mockResolvedValue(undefined);
});
it.each([
  {
    key: "aiStopBackgroundJobs",
    defaultValue: false,
    explicit: true,
    invalid: [undefined, null, false, "true", 1],
    setter: setAiStopBackgroundJobs,
  },
  {
    key: "aiStopSubagents",
    defaultValue: true,
    explicit: false,
    invalid: [undefined, null, true, "false", 0],
    setter: setAiStopSubagents,
  },
  {
    key: "aiAllowUnmanagedJobs",
    defaultValue: false,
    explicit: true,
    invalid: [undefined, null, false, "true", 1],
    setter: setAiAllowUnmanagedJobs,
  },
] as const)(
  "$key preserves its default and writes through the native gate",
  async ({ key, defaultValue, explicit, invalid, setter }) => {
    for (const value of invalid) {
      fake.values = { [key]: value };
      expect((await loadPreferences())[key]).toBe(defaultValue);
    }
    fake.values = { [key]: explicit };
    expect((await loadPreferences())[key]).toBe(explicit);
    await setter(explicit);
    expect(fake.mutate).toHaveBeenCalledWith({
      kind: "set",
      key,
      value: explicit,
    });
  },
);
