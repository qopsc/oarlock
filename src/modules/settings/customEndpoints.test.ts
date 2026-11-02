import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  entries: [] as [string, unknown][],
  endpoints: vi.fn(),
}));
vi.mock("./nativePreferences", () => ({
  readNativePreferences: async () => ({
    revision: 0,
    values: Object.fromEntries(fake.entries),
  }),
}));
vi.mock("./endpoints", () => ({
  loadCustomEndpoints: fake.endpoints,
  onCustomEndpoints: vi.fn(),
}));
const endpoint = {
  id: "ab12cd34",
  name: "Gateway",
  baseURL: "https://one.example/v1",
  modelId: "m",
  contextLimit: 128_000,
};
import { loadPreferences } from "./store";
beforeEach(() => {
  fake.entries = [];
  fake.endpoints.mockReset().mockResolvedValue([endpoint]);
});
it("uses native endpoints for model selections despite a stale plugin list", async () => {
  fake.entries = [
    ["customEndpoints", []],
    ["defaultModelId", "compat-ab12cd34"],
    ["favoriteModelIds", ["compat-ab12cd34"]],
    ["recentModelIds", ["compat-ab12cd34"]],
  ];
  const prefs = await loadPreferences();
  expect(prefs.customEndpoints).toEqual([endpoint]);
  expect(prefs.defaultModelId).toBe("compat-ab12cd34");
  expect(prefs.favoriteModelIds).toEqual(["compat-ab12cd34"]);
  expect(prefs.recentModelIds).toEqual(["compat-ab12cd34"]);
});
it("never resurrects deleted endpoints from legacy or plugin settings", async () => {
  fake.endpoints.mockResolvedValue([]);
  fake.entries = [
    ["customEndpoints", [endpoint]],
    ["openaiCompatibleBaseURL", "https://old.example"],
    ["openaiCompatibleModelId", "old-model"],
    ["defaultModelId", "compat-ab12cd34"],
  ];
  const prefs = await loadPreferences();
  expect(prefs.customEndpoints).toEqual([]);
  expect(prefs.defaultModelId).toBe("gpt-5.4-mini");
});
it("rejects unfinished or removed models without changing persisted preferences", async () => {
  fake.endpoints.mockResolvedValue([{ ...endpoint, modelId: "" }]);
  fake.entries = [
    ["defaultModelId", "compat-ab12cd34"],
    ["favoriteModelIds", ["compat-ab12cd34", "gpt-5.4-mini"]],
  ];
  const prefs = await loadPreferences();
  expect(prefs.defaultModelId).toBe("gpt-5.4-mini");
  expect(prefs.favoriteModelIds).toEqual(["gpt-5.4-mini"]);
  expect(fake.entries[0][1]).toBe("compat-ab12cd34");
});
it("surfaces an unreadable endpoint store and keeps legacy entries disabled", async () => {
  fake.endpoints.mockRejectedValue(new Error("endpoint file damaged"));
  fake.entries = [["customEndpoints", [endpoint]]];
  const prefs = await loadPreferences();
  expect(prefs.customEndpoints).toEqual([]);
  expect(prefs.customEndpointsError).toContain("endpoint file damaged");
});
it("keeps a saved private model selected and blocked while its endpoint file is unavailable", async () => {
  fake.endpoints.mockRejectedValue(new Error("temporarily unreadable"));
  fake.entries = [
    ["defaultModelId", "compat-ab12cd34"],
    ["favoriteModelIds", ["compat-ab12cd34", "gpt-5.4-mini"]],
    ["recentModelIds", ["compat-ab12cd34"]],
  ];
  const prefs = await loadPreferences();
  expect(prefs.defaultModelId).toBe("compat-ab12cd34");
  expect(prefs.favoriteModelIds).toEqual(["compat-ab12cd34", "gpt-5.4-mini"]);
  expect(prefs.recentModelIds).toEqual(["compat-ab12cd34"]);
  const { resolveModelTarget } = await import("@/modules/ai/lib/modelTarget");
  expect(() =>
    resolveModelTarget(prefs.defaultModelId, {
      customEndpoints: prefs.customEndpoints,
    }),
  ).toThrow("Custom endpoint not found");
  // Metadata recovery alone is insufficient until the credential read resolves.
  expect(() =>
    resolveModelTarget(prefs.defaultModelId, { customEndpoints: [endpoint] }),
  ).toThrow(/loading/);
  // Confirmed keyless readiness makes the same selection usable.
  expect(
    resolveModelTarget(prefs.defaultModelId, {
      customEndpoints: [endpoint],
      customEndpointKeys: { [endpoint.id]: null },
    }),
  ).toMatchObject({ provider: "openai-compatible", modelId: "m" });
});

it("canonicalizes legacy selections and lists against the native endpoint without rewriting old settings", async () => {
  fake.endpoints.mockResolvedValue([
    { ...endpoint, id: "legacy", modelId: "current" },
  ]);
  fake.entries = [
    ["defaultModelId", "openai-compatible-custom"],
    ["autocompleteModelId", "openai-compatible-custom"],
    ["favoriteModelIds", ["openai-compatible-custom", "compat-legacy"]],
    ["recentModelIds", ["openai-compatible-custom"]],
    ["openaiCompatibleBaseURL", "https://retired.example/v1"],
    ["openaiCompatibleModelId", "retired-model"],
  ];
  const prefs = await loadPreferences();
  expect(prefs.defaultModelId).toBe("compat-legacy");
  expect(prefs.autocompleteModelId).toBe("compat-legacy");
  expect(prefs.favoriteModelIds).toEqual(["compat-legacy"]);
  expect(prefs.recentModelIds).toEqual(["compat-legacy"]);
  expect(fake.entries[0][1]).toBe("openai-compatible-custom");
});
it("a removed legacy endpoint keeps its saved default blocked rather than selecting a cloud provider", async () => {
  fake.endpoints.mockResolvedValue([]);
  fake.entries = [
    ["defaultModelId", "openai-compatible-custom"],
    ["openaiCompatibleBaseURL", "https://retired.example"],
    ["openaiCompatibleModelId", "retired"],
  ];
  const prefs = await loadPreferences();
  expect(prefs.defaultModelId).toBe("compat-legacy");
  const { resolveModelTarget } = await import("@/modules/ai/lib/modelTarget");
  expect(() =>
    resolveModelTarget(prefs.defaultModelId, {
      customEndpoints: prefs.customEndpoints,
    }),
  ).toThrow("Custom endpoint not found: legacy");
});
