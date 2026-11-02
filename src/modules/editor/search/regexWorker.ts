import { evaluateRegex } from "./regexEvaluation";
import type { RegexInput } from "./regexTypes";
self.onmessage = (event: MessageEvent<RegexInput>) => {
  try {
    self.postMessage({ matches: evaluateRegex(event.data) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : "Regex search failed.",
    });
  }
};
