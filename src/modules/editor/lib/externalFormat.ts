import type { EditorFormatter } from "@/modules/settings/store";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";

export type ExternalFormatter = Exclude<EditorFormatter, "lsp">;

type FormatterDef = {
  label: string;
  /** languageResolver ids the global default applies to; explicit
   * per-language overrides bypass this gate. */
  langs: readonly string[];
};

export const FORMATTERS: Record<
  Exclude<ExternalFormatter, "custom">,
  FormatterDef
> = {
  biome: {
    label: "Biome",
    langs: ["js", "jsx", "ts", "tsx", "json", "css"],
  },
  prettier: {
    label: "Prettier",
    langs: [
      "js",
      "jsx",
      "ts",
      "tsx",
      "json",
      "css",
      "html",
      "vue",
      "svelte",
      "md",
      "yaml",
    ],
  },
  ruff: { label: "Ruff", langs: ["py"] },
  rustfmt: {
    label: "rustfmt",
    langs: ["rs"],
  },
  gofmt: { label: "gofmt", langs: ["go"] },
  "clang-format": {
    label: "clang-format",
    langs: ["c", "h", "cpp", "cc", "hpp"],
  },
  shfmt: { label: "shfmt", langs: ["sh", "bash", "zsh"] },
  zigfmt: { label: "zig fmt", langs: ["zig"] },
};

export const FORMATTER_LABELS: Record<EditorFormatter, string> = {
  lsp: "Language server",
  custom: "Custom command",
  ...Object.fromEntries(
    Object.entries(FORMATTERS).map(([id, def]) => [id, def.label]),
  ),
} as Record<EditorFormatter, string>;

type FormatterPrefs = {
  editorFormatter: EditorFormatter;
  editorFormatterByLang: Record<string, EditorFormatter>;
};

// Explicit overrides always win and always run. The global default only
// applies to languages its tool understands; anything else falls back to
// the language server so a global "biome" never chews on a .py file.
export function resolveFormatter(
  langId: string | null,
  prefs: FormatterPrefs,
): EditorFormatter {
  const override = langId ? prefs.editorFormatterByLang[langId] : undefined;
  if (override) return override;
  const global = prefs.editorFormatter;
  if (global === "lsp" || global === "custom") return global;
  return langId && FORMATTERS[global].langs.includes(langId) ? global : "lsp";
}

/** The native boundary runs stdin/stdout only and rejects unsupported legacy commands. */
export async function runExternalFormatter(
  formatter: ExternalFormatter,
  path: string,
  content: string,
  customCommand = "",
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
  language: string | null = null,
): Promise<{ content: string; size: number }> {
  return invoke("fs_format_document", {
    formatter,
    path,
    content,
    customCommand,
    workspace,
    ...(language ? { language } : {}),
  });
}
