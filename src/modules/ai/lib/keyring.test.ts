import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => core);

import {
  clearKey,
  clearCustomEndpointKey,
  EMPTY_PROVIDER_KEYS,
  getAllCustomEndpointKeys,
  getAllKeys,
  getKey,
  readKey,
  readCustomEndpointKey,
  getCustomEndpointKey,
  hasAnyKey,
  setCustomEndpointKey,
  setKey,
} from "./keyring";

const secretsArgs = (account: string) => ({
  service: "oarlock-ai",
  account,
});

describe("provider keyring", () => {
  beforeEach(() => {
    core.invoke.mockReset();
  });

  it("strict readers distinguish missing credentials from a failed lookup", async () => {
    core.invoke.mockResolvedValue(null);
    await expect(readKey("openai")).resolves.toBeNull();
    await expect(readCustomEndpointKey("e1")).resolves.toBeNull();
    core.invoke.mockRejectedValue(new Error("keychain locked"));
    await expect(readKey("openai")).rejects.toThrow("keychain locked");
    await expect(readCustomEndpointKey("e1")).rejects.toThrow(
      "keychain locked",
    );
  });

  it("strict local-provider reads do not access the keychain", async () => {
    for (const provider of ["lmstudio", "mlx", "ollama"] as const)
      await expect(readKey(provider)).resolves.toBeNull();
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it("reports failed key deletion instead of claiming the credential was removed", async () => {
    core.invoke.mockRejectedValue(new Error("credential store locked"));
    await expect(clearKey("openai")).rejects.toThrow("credential store locked");
    await expect(clearCustomEndpointKey("e1")).rejects.toThrow(
      "credential store locked",
    );
  });

  it("accepts confirmed deletion and leaves keyless providers alone", async () => {
    core.invoke.mockResolvedValue(undefined);
    await clearKey("ollama");
    expect(core.invoke).not.toHaveBeenCalled();
    await clearKey("openai");
    expect(core.invoke).toHaveBeenLastCalledWith(
      "secrets_delete",
      secretsArgs("openai-api-key"),
    );
    await clearCustomEndpointKey("e1");
    expect(core.invoke).toHaveBeenLastCalledWith("ai_endpoint_credential", {
      change: { kind: "clear", id: "e1" },
    });
  });

  it("reads a provider key from the OS keychain service", async () => {
    core.invoke.mockResolvedValue("sk-secret");

    await expect(getKey("openai")).resolves.toBe("sk-secret");
    expect(core.invoke).toHaveBeenCalledWith("secrets_get", {
      ...secretsArgs("openai-api-key"),
      strict: true,
    });
  });

  it("maps an absent read to null and swallows backend failures", async () => {
    core.invoke.mockResolvedValueOnce(null);
    await expect(getKey("openai")).resolves.toBeNull();

    core.invoke.mockResolvedValueOnce("");
    await expect(getKey("anthropic")).resolves.toBeNull();

    core.invoke.mockRejectedValueOnce(new Error("locked"));
    await expect(getKey("google")).resolves.toBeNull();
  });

  it("refuses to store empty or blank keys", async () => {
    await expect(setKey("groq", "   ")).rejects.toThrow(/empty/);
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it("trims and stores a key under the provider account", async () => {
    await setKey("groq", "  gsk-key  ");

    expect(core.invoke).toHaveBeenCalledWith("secrets_set", {
      service: "oarlock-ai",
      account: "groq-api-key",
      password: "gsk-key",
    });
  });

  it("batch-reads all keyed providers and maps results by id", async () => {
    core.invoke.mockResolvedValueOnce(
      ["sk-o", null, "", "x"].map((value) => ({ status: "ready", value })),
    );
    const keys = await getAllKeys();

    expect(keys.openai).toBe("sk-o");
    expect(keys.anthropic).toBeNull();
    expect(keys.google).toMatchObject({ status: "failed" });
    expect(keys.xai).toBe("x");
    expect(keys.ollama).toBeNull();
    const call = core.invoke.mock.calls[0];
    expect(call[0]).toBe("secrets_get_all");
  });

  it("preserves batch failure for every keyed provider without anonymous fallback", async () => {
    core.invoke.mockRejectedValueOnce(new Error("keychain locked"));
    const keys = await getAllKeys();
    expect(keys.openai).toMatchObject({
      status: "failed",
      error: expect.stringContaining("locked"),
    });
    expect(keys.openrouter).toMatchObject({ status: "failed" });
    expect(keys.ollama).toBeNull();
    expect(core.invoke).toHaveBeenCalledOnce();
  });

  it("hasAnyKey is true only when a keyed provider holds a value", () => {
    expect(hasAnyKey({ ...EMPTY_PROVIDER_KEYS })).toBe(false);
    expect(hasAnyKey({ ...EMPTY_PROVIDER_KEYS, ollama: "anything" })).toBe(
      false,
    );
    expect(hasAnyKey({ ...EMPTY_PROVIDER_KEYS, openai: "sk-1" })).toBe(true);
  });

  it("stores custom endpoint keys under compat accounts", async () => {
    await setCustomEndpointKey("e1", "https://example.com/v1", " k ");
    expect(core.invoke).toHaveBeenCalledWith("ai_endpoint_credential", {
      change: {
        kind: "set",
        id: "e1",
        baseURL: "https://example.com/v1",
        key: "k",
      },
    });

    core.invoke.mockResolvedValueOnce("v");
    await expect(getCustomEndpointKey("e1")).resolves.toEqual({
      origin: null,
      key: "v",
    });

    await expect(
      setCustomEndpointKey("e1", "https://example.com/v1", " "),
    ).rejects.toThrow(/empty/);
    expect(core.invoke).not.toHaveBeenCalledWith(
      "secrets_set",
      expect.objectContaining({ password: "" }),
    );
  });

  it("maps custom endpoint batch results and tolerates an empty list", async () => {
    await expect(getAllCustomEndpointKeys([])).resolves.toEqual({});
    expect(core.invoke).not.toHaveBeenCalled();

    core.invoke.mockResolvedValueOnce(
      [null, "two"].map((value) => ({ status: "ready", value })),
    );
    const keys = await getAllCustomEndpointKeys([
      { id: "a", name: "A", baseURL: "http://a" },
      { id: "b", name: "B", baseURL: "http://b" },
    ] as never);

    expect(keys).toEqual({ a: null, b: { origin: null, key: "two" } });
  });

  it("keeps mixed endpoint failures separate from missing and valid keys", async () => {
    core.invoke.mockResolvedValueOnce([
      { status: "ready", value: null },
      { status: "failed", error: "locked" },
      {
        status: "ready",
        value: JSON.stringify({
          format: "oarlock-endpoint-key-v1",
          origin: "https://server.test",
          key: "secret",
        }),
      },
    ]);
    const endpoints = ["missing", "failed", "valid", "no-result"].map((id) => ({
      id,
      name: id,
      baseURL: "https://server.test/v1",
      modelId: "model",
      contextLimit: 10000,
    }));
    const result = await getAllCustomEndpointKeys(endpoints);
    expect(result.missing).toBeNull();
    expect(result.failed).toEqual({ status: "failed", error: "locked" });
    expect(result.valid).toEqual({
      origin: "https://server.test",
      key: "secret",
    });
    expect(result["no-result"]).toMatchObject({ status: "failed" });
  });

  it("EMPTY_PROVIDER_KEYS covers every keyed provider in config", async () => {
    const { PROVIDERS, providerSupportsKey } = await import("../config");
    const emptyKeys = Object.keys(EMPTY_PROVIDER_KEYS);
    for (const p of PROVIDERS.filter((p) => providerSupportsKey(p.id))) {
      expect(emptyKeys, `${p.id} missing from EMPTY_PROVIDER_KEYS`).toContain(
        p.id,
      );
    }
    expect(Object.values(EMPTY_PROVIDER_KEYS).every((v) => v === null)).toBe(
      true,
    );
  });
});

it("a retired provider-wide compatible key alone does not enable AI", () => {
  expect(
    hasAnyKey({ ...EMPTY_PROVIDER_KEYS, "openai-compatible": "legacy-secret" }),
  ).toBe(false);
});
