import type { SttProvider } from "../config";
import { readyKey } from "./credentialState";
import type { ProviderKeys } from "./keyring";
import type { SttOptions } from "./stt";

/** Only the selected provider's execution inputs own the recording. */
export function voiceConfiguration(
  settings: SttOptions & { sttProvider: SttProvider },
  keys: ProviderKeys,
) {
  const provider = settings.sttProvider;
  return {
    provider,
    key: provider === "whispercpp" ? null : readyKey(keys[provider]),
    option:
      provider === "groq"
        ? settings.groqSttModel
        : provider === "whispercpp"
          ? settings.whispercppBaseURL
          : undefined,
  };
}

export function sameVoiceConfiguration(
  a: ReturnType<typeof voiceConfiguration>,
  b: ReturnType<typeof voiceConfiguration>,
) {
  return a.provider === b.provider && a.key === b.key && a.option === b.option;
}
