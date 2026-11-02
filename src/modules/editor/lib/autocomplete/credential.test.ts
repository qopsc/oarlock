import { expect, it } from "vitest";
import { completionAccess, type CompletionCredential } from "./credential";

const cached: CompletionCredential = {
  status: "ready",
  provider: "openai-compatible",
  modelId: "compat-a",
  key: null,
  endpoint: { origin: "https://one.example", key: "secret" },
};
const access = (
  credential: CompletionCredential | null = cached,
  url = "https://one.example/v1",
) => completionAccess(credential, "openai-compatible", "compat-a", url);

it("keeps same-origin endpoint keys and refuses changed origins or unbound keys", () => {
  expect(access(cached, "https://one.example/v2")).toEqual({
    credentialStatus: "ready",
    apiKey: "secret",
  });
  expect(access(cached, "https://two.example/v1")).toEqual({
    credentialStatus: "failed",
    apiKey: null,
  });
  expect(
    access({
      ...cached,
      status: "ready",
      key: null,
      endpoint: { origin: null, key: "legacy" },
    }),
  ).toEqual({ credentialStatus: "failed", apiKey: null });
});

it("cannot use a delayed read for another provider or endpoint", () => {
  expect(
    completionAccess(
      cached,
      "openai-compatible",
      "compat-b",
      "https://one.example/v1",
    ).credentialStatus,
  ).toBe("loading");
  expect(completionAccess(cached, "groq", "model", "").credentialStatus).toBe(
    "loading",
  );
});

it("only a successful absent-key lookup permits a custom endpoint to run keyless", () => {
  expect(access(null)).toEqual({ credentialStatus: "loading", apiKey: null });
  for (const status of ["loading", "failed"] as const)
    expect(
      access({ provider: "openai-compatible", modelId: "compat-a", status }),
    ).toEqual({ credentialStatus: status, apiKey: null });
  expect(
    access({ ...cached, status: "ready", key: null, endpoint: null }),
  ).toEqual({ credentialStatus: "keyless", apiKey: null });
});

it("cloud providers need a successfully loaded key", () => {
  const cloud: CompletionCredential = {
    status: "ready",
    provider: "openai",
    modelId: "model",
    key: "cloud-secret",
    endpoint: null,
  };
  expect(completionAccess(cloud, "openai", "model", "")).toEqual({
    credentialStatus: "ready",
    apiKey: "cloud-secret",
  });
  expect(
    completionAccess({ ...cloud, key: null }, "openai", "model", ""),
  ).toEqual({ credentialStatus: "failed", apiKey: null });
});

it.each(["lmstudio", "mlx", "ollama"] as const)(
  "%s is intentionally keyless without any lookup",
  (provider) => {
    expect(completionAccess(null, provider, "model", "")).toEqual({
      credentialStatus: "keyless",
      apiKey: null,
    });
  },
);
