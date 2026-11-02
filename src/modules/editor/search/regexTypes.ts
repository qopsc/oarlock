export type RegexSpec = {
  search: string;
  replace: string;
  regexp: true;
  caseSensitive: boolean;
  wholeWord: boolean;
  literal: boolean;
};
export type RegexMatch = { from: number; to: number; insert: string };
export type RegexInput = { text: string; spec: RegexSpec };
export const MAX_TEXT_UNITS = 8 * 1024 * 1024;
export const MAX_MATCHES = 10_000;
export const MAX_PATTERN_UNITS = 4096;
export function validateInput(input: RegexInput): void {
  if (input.text.length > MAX_TEXT_UNITS)
    throw new Error(
      "Document is too large for regex search (16 MiB maximum). Use literal search.",
    );
  if (input.spec.search.length > MAX_PATTERN_UNITS)
    throw new Error("Regex is too long (4,096 characters maximum).");
  if (input.spec.replace.length > MAX_PATTERN_UNITS)
    throw new Error(
      "Regex replacement is too long (4,096 characters maximum).",
    );
}
