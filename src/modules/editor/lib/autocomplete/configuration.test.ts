import { expect, it } from "vitest";
import { hasCompletionProvider } from "./configuration";
import type { CompletionDeps } from "./provider";
const prefs: CompletionDeps = {
  provider: "openai",
  modelId: "m",
  apiKey: null,
  credentialStatus: "keyless",
  lmstudioBaseURL: "",
};
it.each([
  ["lmstudio", "lmstudioBaseURL"],
  ["mlx", "mlxBaseURL"],
  ["ollama", "ollamaBaseURL"],
  ["openai-compatible", "openaiCompatibleBaseURL"],
] as const)(
  "allows %s without a key when its server is configured",
  (provider, field) => {
    expect(
      hasCompletionProvider({
        ...prefs,
        provider,
        [field]: "http://localhost:8080/v1",
      }),
    ).toBe(true);
    expect(hasCompletionProvider({ ...prefs, provider, [field]: "" })).toBe(
      false,
    );
    expect(hasCompletionProvider({ ...prefs, provider, [field]: "   " })).toBe(
      false,
    );
  },
);
it("requires a key for cloud providers even when another provider's URL exists", () => {
  expect(
    hasCompletionProvider({ ...prefs, lmstudioBaseURL: "http://localhost" }),
  ).toBe(false);
  expect(hasCompletionProvider({ ...prefs, apiKey: "secret" })).toBe(true);
});

it.each(["loading", "failed"] as const)(
  "blocks %s credentials even with a server and key",
  (credentialStatus) => {
    expect(
      hasCompletionProvider({ ...prefs, credentialStatus, apiKey: "secret" }),
    ).toBe(false);
    expect(
      hasCompletionProvider({
        ...prefs,
        provider: "openai-compatible",
        credentialStatus,
        openaiCompatibleBaseURL: "https://server.test/v1",
      }),
    ).toBe(false);
  },
);
