import type { ProviderId } from "@/modules/ai/config";
import {
  endpointKeyFor,
  type EndpointCredential,
} from "@/modules/ai/lib/endpointCredentials";

export type CompletionCredential = {
  provider: ProviderId;
  modelId: string;
} & (
  | { status: "loading" | "failed" }
  | { status: "ready"; key: string | null; endpoint: EndpointCredential | null }
);

export type CompletionAccess = {
  credentialStatus: "loading" | "failed" | "ready" | "keyless";
  apiKey: string | null;
};

/** A successful, absent key is distinct from a lookup that has not succeeded. */
export function completionAccess(
  cached: CompletionCredential | null,
  provider: ProviderId,
  modelId: string,
  baseURL: string,
): CompletionAccess {
  if (["lmstudio", "mlx", "ollama"].includes(provider))
    return { credentialStatus: "keyless", apiKey: null };
  if (!cached || cached.provider !== provider || cached.modelId !== modelId)
    return { credentialStatus: "loading", apiKey: null };
  if (cached.status !== "ready")
    return { credentialStatus: cached.status, apiKey: null };
  if (provider === "openai-compatible") {
    const apiKey = endpointKeyFor(cached.endpoint, baseURL);
    // Same origin rule as chat's resolveModelTarget: an existing unbound or
    // mismatched credential must not silently become a keyless request.
    return {
      credentialStatus: cached.endpoint
        ? apiKey
          ? "ready"
          : "failed"
        : "keyless",
      apiKey,
    };
  }
  const apiKey = cached.key?.trim() ? cached.key : null;
  return { credentialStatus: apiKey ? "ready" : "failed", apiKey };
}
