import {
  CREDENTIAL_LOADING,
  credentialUnavailable,
  type CredentialValue,
  type CredentialUnavailable,
  readyKey,
} from "./credentialState";
import {
  decodeEndpointKey,
  type EndpointCredential,
} from "./endpointCredentials";
import { invoke } from "@tauri-apps/api/core";
import {
  getProvider,
  KEYRING_SERVICE,
  PROVIDERS,
  providerSupportsKey,
  type CustomEndpoint,
  type ProviderId,
} from "../config";

export type ProviderKeys = Record<ProviderId, CredentialValue<string>>;
export type CustomEndpointKeys = Record<
  string,
  CredentialValue<EndpointCredential>
>;

export const EMPTY_PROVIDER_KEYS: ProviderKeys = {
  openai: null,
  anthropic: null,
  google: null,
  xai: null,
  cerebras: null,
  groq: null,
  deepseek: null,
  mistral: null,
  openrouter: null,
  "openai-compatible": null,
  lmstudio: null,
  mlx: null,
  ollama: null,
};

/** A missing key is null; a failed lookup rejects so callers can fail closed. */
export async function readKey(provider: ProviderId): Promise<string | null> {
  if (!providerSupportsKey(provider)) return null;
  const v = await invoke<string | null>("secrets_get", {
    service: KEYRING_SERVICE,
    account: getProvider(provider).keyringAccount,
    strict: true,
  });
  return v && v.length > 0 ? v : null;
}

export async function getKey(provider: ProviderId): Promise<string | null> {
  try {
    return await readKey(provider);
  } catch {
    return null;
  }
}

export async function setKey(provider: ProviderId, key: string): Promise<void> {
  if (!providerSupportsKey(provider)) {
    throw new Error(`${provider} does not use an API key`);
  }
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is empty");
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account: getProvider(provider).keyringAccount,
    password: trimmed,
  });
}

export async function clearKey(provider: ProviderId): Promise<void> {
  if (!providerSupportsKey(provider)) return;
  await invoke("secrets_delete", {
    service: KEYRING_SERVICE,
    account: getProvider(provider).keyringAccount,
  });
}

type SecretRead =
  | { status: "ready"; value: string | null }
  | { status: "failed"; error: string };
async function readBatch(
  accounts: string[],
): Promise<CredentialValue<string>[]> {
  if (!accounts.length) return [];
  try {
    const results = await invoke<SecretRead[]>("secrets_get_all", {
      service: KEYRING_SERVICE,
      accounts,
    });
    return accounts.map((_, i) => {
      const result = results[i];
      if (
        result?.status === "ready" &&
        (result.value === null ||
          (typeof result.value === "string" && result.value.length))
      )
        return result.value;
      return {
        status: "failed",
        error:
          result?.status === "failed"
            ? result.error
            : "Invalid credential read result",
      };
    });
  } catch (error) {
    return accounts.map(() => ({ status: "failed", error: String(error) }));
  }
}

export function pendingProviderKeys(
  unavailable: CredentialUnavailable = CREDENTIAL_LOADING,
): ProviderKeys {
  const out = { ...EMPTY_PROVIDER_KEYS };
  for (const p of PROVIDERS)
    if (providerSupportsKey(p.id)) out[p.id] = unavailable;
  return out;
}
export function pendingEndpointKeys(
  endpoints: readonly CustomEndpoint[],
  unavailable: CredentialUnavailable = CREDENTIAL_LOADING,
): CustomEndpointKeys {
  return Object.fromEntries(endpoints.map((e) => [e.id, unavailable]));
}
export async function getAllKeys(): Promise<ProviderKeys> {
  const out = { ...EMPTY_PROVIDER_KEYS };
  const need = PROVIDERS.filter((p) => providerSupportsKey(p.id));
  const values = await readBatch(need.map((p) => p.keyringAccount));
  need.forEach((p, i) => {
    out[p.id] = values[i];
  });
  return out;
}

/** Keep an already-loaded composer available to display blocked credential states. */
export function hasUnavailableProviderKeys(keys: ProviderKeys): boolean {
  return PROVIDERS.some(
    (p) =>
      p.id !== "openai-compatible" &&
      providerSupportsKey(p.id) &&
      credentialUnavailable(keys[p.id]),
  );
}

export function hasAnyKey(keys: ProviderKeys): boolean {
  return PROVIDERS.some(
    (p) =>
      p.id !== "openai-compatible" &&
      providerSupportsKey(p.id) &&
      !!readyKey(keys[p.id]),
  );
}

function compatKeyringAccount(endpointId: string): string {
  return `compat-${endpointId}-api-key`;
}

export async function getCustomEndpointKey(
  endpointId: string,
): Promise<EndpointCredential | null> {
  try {
    return await readCustomEndpointKey(endpointId);
  } catch {
    return null;
  }
}

/** Preserve keychain errors instead of interpreting them as a keyless endpoint. */
export async function readCustomEndpointKey(
  endpointId: string,
): Promise<EndpointCredential | null> {
  const v = await invoke<string | null>("secrets_get", {
    service: KEYRING_SERVICE,
    account: compatKeyringAccount(endpointId),
    strict: true,
  });
  return decodeEndpointKey(v);
}

export async function setCustomEndpointKey(
  endpointId: string,
  baseURL: string,
  key: string,
): Promise<EndpointCredential> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is empty");
  return invoke<EndpointCredential>("ai_endpoint_credential", {
    change: { kind: "set", id: endpointId, baseURL, key: trimmed },
  });
}

export async function clearCustomEndpointKey(
  endpointId: string,
): Promise<void> {
  await invoke("ai_endpoint_credential", {
    change: { kind: "clear", id: endpointId },
  });
}

export async function getAllCustomEndpointKeys(
  endpoints: readonly CustomEndpoint[],
): Promise<CustomEndpointKeys> {
  const values = await readBatch(
    endpoints.map((e) => compatKeyringAccount(e.id)),
  );
  return Object.fromEntries(
    endpoints.map((e, i) => {
      const value = values[i];
      return [
        e.id,
        typeof value === "object" && value !== null
          ? value
          : decodeEndpointKey(value),
      ];
    }),
  );
}
