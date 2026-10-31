import type { CompletionDeps } from "./provider";

/** Whether this provider has the connection or credential needed to request completion. */
export function hasCompletionProvider(prefs: CompletionDeps): boolean {
  if (
    prefs.credentialStatus !== "ready" &&
    prefs.credentialStatus !== "keyless"
  )
    return false;
  switch (prefs.provider) {
    case "lmstudio":
      return !!prefs.lmstudioBaseURL?.trim();
    case "mlx":
      return !!prefs.mlxBaseURL?.trim();
    case "ollama":
      return !!prefs.ollamaBaseURL?.trim();
    case "openai-compatible":
      return !!prefs.openaiCompatibleBaseURL?.trim();
    default:
      return !!prefs.apiKey?.trim();
  }
}
