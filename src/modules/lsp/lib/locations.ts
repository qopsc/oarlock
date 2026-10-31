export type LspPos = { line: number; character: number };
type LspRange = { start: LspPos };

export type LspLocation = { uri: string; range: LspRange };
type LspLocationLink = {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
};
export type DefinitionResult =
  | LspLocation
  | LspLocation[]
  | LspLocationLink[]
  | null
  | undefined;

function validRange(value: unknown): value is LspRange {
  if (!value || typeof value !== "object" || !("start" in value)) return false;
  const start = value.start;
  return (
    !!start &&
    typeof start === "object" &&
    "line" in start &&
    typeof start.line === "number" &&
    Number.isSafeInteger(start.line) &&
    start.line >= 0 &&
    "character" in start &&
    typeof start.character === "number" &&
    Number.isSafeInteger(start.character) &&
    start.character >= 0
  );
}

export function normalizeLocations(result: unknown): LspLocation[] {
  const list = Array.isArray(result) ? result : [result];
  const out: LspLocation[] = [];
  for (const loc of list) {
    if (!loc || typeof loc !== "object") continue;
    const uri = "uri" in loc ? loc.uri : loc.targetUri;
    const range =
      "uri" in loc ? loc.range : (loc.targetSelectionRange ?? loc.targetRange);
    if (typeof uri === "string" && uri.length > 0 && validRange(range))
      out.push({ uri, range });
  }
  return out;
}
