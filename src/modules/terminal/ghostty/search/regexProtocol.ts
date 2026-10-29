export const MAX_REGEX_MATCHES = 10_000;
export const REGEX_PATTERN_UNITS = 4_096;
export const REGEX_BATCH_LINES = 128;
export const REGEX_BATCH_CELLS = 65_536;
export const REGEX_BATCH_UNITS = 131_072;
export const REGEX_TOTAL_UNITS = 8 * 1024 * 1024;
export const REGEX_TOTAL_MS = 10_000;

export type RegexMatch = {
  line: number;
  startColumn: number;
  endColumn: number;
};
export type RegexBatch = {
  pattern: string;
  lines: readonly (readonly string[])[];
  firstLine: number;
  limit: number;
};
export type RegexReply = { id: number; matches?: RegexMatch[]; error?: string };

export function validateRegexBatch(batch: RegexBatch): void {
  if (
    !batch.pattern ||
    batch.pattern.length > REGEX_PATTERN_UNITS ||
    !Number.isSafeInteger(batch.firstLine) ||
    batch.firstLine < 0 ||
    !Number.isInteger(batch.limit) ||
    batch.limit < 1 ||
    batch.limit > MAX_REGEX_MATCHES ||
    batch.lines.length < 1 ||
    batch.lines.length > REGEX_BATCH_LINES
  ) {
    throw new Error("Invalid or oversized regex request.");
  }
  let cells = 0;
  let units = 0;
  for (const row of batch.lines) {
    cells += row.length;
    for (const cell of row) units += cell.length;
    if (cells > REGEX_BATCH_CELLS || units > REGEX_BATCH_UNITS)
      throw new Error("Regex input batch is too large.");
  }
}
