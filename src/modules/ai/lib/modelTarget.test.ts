import { describe, expect, it } from "vitest";
import { compatModelIdForEndpoint, type CustomEndpoint } from "../config";
import { EMPTY_PROVIDER_KEYS } from "./keyring";
import {
  modelConfigProblem,
  resolveModelTarget,
  type LocalProviderConfig,
} from "./modelTarget";

const endpoint: CustomEndpoint = {
  id: "ep1",
  name: "My LLM",
  baseURL: "https://llm.example.com/v1",
  modelId: " llama-3.3-70b ",
  contextLimit: 64_000,
};

describe("resolveModelTarget", () => {
  it("sends a custom endpoint its own model id, base URL and key", () => {
    expect(
      resolveModelTarget(compatModelIdForEndpoint("ep1"), {
        customEndpoints: [endpoint],
        customEndpointKeys: {
          ep1: { origin: "https://llm.example.com", key: "sk-ep" },
        },
      }),
    ).toEqual({
      provider: "openai-compatible",
      modelId: "llama-3.3-70b",
      options: { openaiCompatibleBaseURL: "https://llm.example.com/v1" },
      endpointKey: "sk-ep",
    });
  });

  it("sends a local server its configured model, never the placeholder id", () => {
    expect(
      resolveModelTarget("ollama-local", {
        ollamaBaseURL: "http://127.0.0.1:11434/v1",
        ollamaModelId: "qwen3:8b",
      }),
    ).toMatchObject({
      provider: "ollama",
      modelId: "qwen3:8b",
      options: { ollamaBaseURL: "http://127.0.0.1:11434/v1" },
    });
  });
});

describe("modelConfigProblem", () => {
  const keys = { ...EMPTY_PROVIDER_KEYS, openai: "sk-test" };

  it("is null for a model that can run", () => {
    expect(modelConfigProblem("gpt-5.4-mini", keys)).toBeNull();
    expect(
      modelConfigProblem(compatModelIdForEndpoint("ep1"), EMPTY_PROVIDER_KEYS, {
        customEndpoints: [endpoint],
        customEndpointKeys: { ep1: null },
      }),
    ).toBeNull();
  });

  it("names what is missing", () => {
    expect(modelConfigProblem("claude-haiku-4-5", keys)).toMatch(
      /^No API key configured for anthropic\./,
    );
    expect(
      modelConfigProblem(compatModelIdForEndpoint("gone"), keys, {
        customEndpoints: [endpoint],
        customEndpointKeys: { ep1: null },
      }),
    ).toBe("Custom endpoint not found: gone");
    expect(modelConfigProblem("ollama-local", keys)).toMatch(
      /^Ollama: no model id set\./,
    );
    expect(modelConfigProblem("not-a-model", keys)).toBe(
      "Unknown model: not-a-model",
    );
  });
});

it("blocks an endpoint's saved key after an origin change, including legacy unbound keys", () => {
  for (const origin of ["https://llm.example.com", null]) {
    expect(() =>
      resolveModelTarget(compatModelIdForEndpoint(endpoint.id), {
        customEndpoints: [{ ...endpoint, baseURL: "https://other.example/v1" }],
        customEndpointKeys: { [endpoint.id]: { origin, key: "old-secret" } },
      }),
    ).toThrow(/re-enter the API key/);
  }
});
it("selects explicit anonymous credentials for a keyless endpoint instead of the legacy provider key", () => {
  expect(
    resolveModelTarget(compatModelIdForEndpoint(endpoint.id), {
      customEndpoints: [endpoint],
      customEndpointKeys: { ep1: null },
    }).endpointKey,
  ).toBeNull();
});

it("legacy references use only the migrated native endpoint, including credentials", () => {
  const config = {
    openaiCompatibleBaseURL: "https://retired.example/v1",
    openaiCompatibleModelId: "retired-model",
    customEndpoints: [{ ...endpoint, id: "legacy" }],
    customEndpointKeys: {
      legacy: { origin: "https://llm.example.com", key: "bound" },
    },
  };
  expect(resolveModelTarget("openai-compatible-custom", config)).toEqual(
    resolveModelTarget("compat-legacy", config),
  );
  expect(resolveModelTarget("openai-compatible-custom", config)).toMatchObject({
    modelId: "llama-3.3-70b",
    endpointKey: "bound",
    options: { openaiCompatibleBaseURL: "https://llm.example.com/v1" },
  });
  for (const customEndpoints of [[], [{ ...endpoint, id: "unrelated" }]]) {
    expect(() =>
      resolveModelTarget("openai-compatible-custom", {
        ...config,
        customEndpoints,
      }),
    ).toThrow("Custom endpoint not found: legacy");
  }
  expect(() =>
    resolveModelTarget("openai-compatible-custom", {
      ...config,
      customEndpoints: [
        { ...endpoint, id: "legacy", baseURL: "https://changed.example/v1" },
      ],
    }),
  ).toThrow(/re-enter the API key/);
});

it.each([
  undefined,
  { status: "loading" as const },
  { status: "failed" as const, error: "locked" },
])("blocks an unresolved endpoint credential: %j", (credential) => {
  const config: LocalProviderConfig = {
    customEndpoints: [endpoint],
    customEndpointKeys: credential === undefined ? {} : { ep1: credential },
  };
  expect(modelConfigProblem("compat-ep1", EMPTY_PROVIDER_KEYS, config)).toMatch(
    /loading|Could not read/,
  );
  expect(() => resolveModelTarget("compat-ep1", config)).toThrow(
    /loading|Could not read/,
  );
});
it.each(["loading", "failed"] as const)(
  "blocks cloud credentials while %s",
  (status) => {
    expect(
      modelConfigProblem("gpt-5.4-mini", {
        ...EMPTY_PROVIDER_KEYS,
        openai: { status },
      }),
    ).toMatch(/loading|Could not read/);
  },
);
