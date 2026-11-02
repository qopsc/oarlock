import type { Preferences } from "@/modules/settings/store";
import { preferencesReady } from "@/modules/settings/readiness";
import { endpointIdFromCompatModel } from "@/modules/ai/config";
import { completionAccess, type CompletionCredential } from "./credential";
import type { AutocompleteContext } from "./inlineExtension";

/** Live execution inputs, distinct from the retained settings shown by the UI. */
export function completionPreferences(
  s: Preferences & Parameters<typeof preferencesReady>[0],
  credential: CompletionCredential | null,
): ReturnType<AutocompleteContext["getPrefs"]> {
  const p = s.autocompleteProvider;
  // autocompleteModelId holds the compat- id of the chosen endpoint.
  const compatEp =
    p === "openai-compatible"
      ? s.customEndpoints.find(
          (e) => e.id === endpointIdFromCompatModel(s.autocompleteModelId),
        )
      : undefined;
  const modelId =
    p === "lmstudio"
      ? s.lmstudioModelId
      : p === "mlx"
        ? s.mlxModelId
        : p === "ollama"
          ? s.ollamaModelId
          : p === "openai-compatible"
            ? (compatEp?.modelId ?? "")
            : p === "openrouter"
              ? s.openrouterModelId
              : s.autocompleteModelId;
  return {
    enabled: s.autocompleteEnabled && preferencesReady(s),
    trigger: s.autocompleteTrigger,
    provider: p,
    modelId,
    ...completionAccess(
      credential,
      p,
      s.autocompleteModelId,
      compatEp?.baseURL ?? "",
    ),
    lmstudioBaseURL: s.lmstudioBaseURL,
    mlxBaseURL: s.mlxBaseURL,
    ollamaBaseURL: s.ollamaBaseURL,
    openaiCompatibleBaseURL: compatEp?.baseURL ?? "",
  };
}
