import { LOCAL_WORKSPACE } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { appConfigDir, join } from "@tauri-apps/api/path";
import type { Theme } from "./types";
import { validateTheme, type ValidationResult } from "./validateTheme";

const THEME_FILE_EXT = ".oarlock-theme";
const THEME_EDIT_EVENT = "oarlock://theme-edit";

export type ThemeEditRequest =
  | { action: "create" }
  | { action: "edit"; id: string };

export function isThemeFilePath(path: string): boolean {
  return path.toLowerCase().endsWith(THEME_FILE_EXT);
}

// Theme files live in the app's own config folder on the host, so they are
// read and written there (`LOCAL_WORKSPACE`) whatever environment the window
// works in: a WSL window's would send the backend looking inside the distro.
async function themesDir(): Promise<string> {
  return join(await appConfigDir(), "themes");
}

export async function themeFilePath(id: string): Promise<string> {
  return join(await themesDir(), `${id}${THEME_FILE_EXT}`);
}

type ThemeFileComparison = "same" | "different" | "unknown";

function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
}

/** Compare without writing: another window may own an unsaved editor buffer. */
export async function compareThemeFile(path: string, theme: Theme): Promise<ThemeFileComparison> {
  try {
    const result = await invoke<{ kind: "text"; content: string } | { kind: "binary" | "toolarge" }>(
      "fs_read_file", { path, workspace: LOCAL_WORKSPACE },
    );
    if (result.kind !== "text") return "unknown";
    try {
      return canonicalJson(JSON.parse(result.content)) === canonicalJson(theme) ? "same" : "different";
    } catch {
      return "different";
    }
  } catch {
    return "unknown";
  }
}

export async function writeThemeFile(theme: Theme): Promise<{ path: string; comparison: ThemeFileComparison }> {
  const dir = await themesDir();
  const workspace = LOCAL_WORKSPACE;
  const dirExists = await invoke("fs_stat", { path: dir, workspace })
    .then(() => true)
    .catch(() => false);
  if (!dirExists) {
    await invoke("fs_create_dir", { path: dir, workspace });
  }
  const path = await join(dir, `${theme.id}${THEME_FILE_EXT}`);
  const result = await invoke<{ kind: "saved" | "conflict" }>("fs_save_document", {
    path,
    content: JSON.stringify(theme, null, 2),
    expectedVersion: null,
    workspace,
    source: "theme",
  });
  if (result.kind === "saved") return { path, comparison: "same" };
  if (result.kind === "conflict") return { path, comparison: await compareThemeFile(path, theme) };
  throw new Error("Could not determine whether the theme file was created");
}

export async function deleteThemeFile(id: string): Promise<void> {
  try {
    const path = await themeFilePath(id);
    await invoke("fs_delete", { path, workspace: LOCAL_WORKSPACE });
  } catch (error) {
    if (String(error).includes("target cannot be safely verified")) throw error;
    /* file may not exist yet — nothing to clean up */
  }
}

export function parseThemeFile(text: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "invalid JSON",
    };
  }
  return validateTheme(parsed);
}

export function starterTheme(): Theme {
  const id = `my-theme-${crypto.randomUUID().slice(0, 8)}`;
  return {
    id,
    name: "My Theme",
    description: "Custom theme.",
    variants: {
      dark: {
        colors: {
          background: "#0d0d10",
          foreground: "#e8e8ea",
          card: "#15151a",
          cardForeground: "#e8e8ea",
          popover: "#15151a",
          popoverForeground: "#e8e8ea",
          primary: "#7dd3fc",
          primaryForeground: "#0d0d10",
          muted: "#1c1c22",
          mutedForeground: "#a0a0a8",
          accent: "#1c1c22",
          accentForeground: "#e8e8ea",
          border: "rgba(255,255,255,0.08)",
          input: "rgba(255,255,255,0.12)",
          ring: "#7dd3fc",
          sidebar: "#0a0a0d",
          sidebarForeground: "#e8e8ea",
          sidebarPrimary: "#7dd3fc",
          sidebarAccent: "#1c1c22",
          sidebarBorder: "rgba(255,255,255,0.08)",
          sidebarRing: "#7dd3fc",
        },
        terminal: {
          background: "#0d0d10",
          foreground: "#e8e8ea",
          cursor: "#e8e8ea",
          cursorAccent: "#0d0d10",
          selection: "rgba(125,211,252,0.22)",
          fontFamily: "JetBrains Mono",
          fontWeight: "normal",
          fontSize: 14,
        },
      },
    },
  };
}

function emitThemeEdit(req: ThemeEditRequest): Promise<void> {
  return invoke("app_theme_edit", { request: req });
}

/**
 * Hands a theme-edit request to the main window and then closes the caller
 * (the Settings window). Closing, not hiding, releases the second WebContent
 * process; Settings is rebuilt on demand by `open_settings_window`. The emit
 * is awaited first so the request is on the event bus before the window goes
 * away, and a failed emit leaves Settings open instead of dropping the edit.
 */
export async function handOffThemeEdit(
  req: ThemeEditRequest,
  closeWindow: () => Promise<void>,
  emitRequest: (req: ThemeEditRequest) => Promise<void> = emitThemeEdit,
): Promise<boolean> {
  try {
    await emitRequest(req);
  } catch (error) {
    console.error("[oarlock] theme edit request failed:", error);
    return false;
  }
  try {
    await closeWindow();
  } catch (error) {
    console.error("[oarlock] could not close settings window:", error);
  }
  return true;
}

export function onThemeEdit(
  cb: (req: ThemeEditRequest) => void,
): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<ThemeEditRequest>(
    THEME_EDIT_EVENT,
    (e) => cb(e.payload),
  );
}
