import { extensionMap, LANGUAGES } from "./languageDefinitions";
import { resolveLanguageDefinition } from "./languageResolver";

const key = (value: string) => value.toLowerCase().replace(/[\s_-]/g, "");
const names = new Map(LANGUAGES.map((def) => [key(def.name), def]));
const aliases: Record<string, string> = {
  javascriptreact: "jsx",
  typescriptreact: "tsx",
  csharp: "cs",
  shellscript: "sh",
  bash: "sh",
  plain: "txt",
  plaintext: "txt",
  text: "txt",
  null: "txt",
};

/** null means filename detection; txt is an explicit plain-text override. */
export function parseFiletype(value: string): string | null {
  const normalized = key(value);
  if (normalized === "auto") return null;
  if (
    !normalized ||
    ["txt", "text", "plain", "plaintext", "null"].includes(normalized)
  )
    return "txt";
  const alias = aliases[normalized] ?? normalized;
  const def = extensionMap.get(alias) ?? names.get(alias);
  if (!def)
    throw Error(
      `Unknown filetype: ${value}. Use a supported language, an empty value for plain text, or filetype& for automatic detection.`,
    );
  return def.extensions[0];
}

export function documentLanguage(path: string, override?: string | null) {
  const def = override
    ? extensionMap.get(override)
    : resolveLanguageDefinition(path);
  const base = path.split(/[\\/]/).pop() ?? "";
  const extension = base.includes(".")
    ? base.split(".").pop()?.toLowerCase()
    : null;
  const fallback = override || extension;
  return {
    id: def?.extensions[0] ?? (fallback === "txt" ? null : fallback || null),
    name: def?.name ?? "Plain Text",
    def,
  };
}
export function vimFiletype(id: string | null): string {
  const aliases: Record<string, string> = {
    py: "python",
    js: "javascript",
    jsx: "javascriptreact",
    ts: "typescript",
    tsx: "typescriptreact",
    rs: "rust",
    md: "markdown",
  };
  return id ? (aliases[id] ?? id) : "";
}
