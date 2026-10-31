import { toast } from "sonner";
import { type RefObject, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { setThemeId as persistThemeId } from "@/modules/settings/store";
import type { Tab } from "@/modules/tabs";
import { workspaceEnvForPath } from "@/modules/workspace";
import { listCustomThemes, readCustomThemes, saveCustomTheme, saveThemeFileSnapshot } from "./customThemes";
import { createThemeFileIngest } from "./themeFileIngest";
import {
  compareThemeFile,
  isThemeFilePath,
  onThemeEdit,
  parseThemeFile,
  starterTheme,
  themeFilePath,
  writeThemeFile,
} from "./themeFiles";

type Params = {
  tabsRef: RefObject<Tab[]>;
  openFileTab: (path: string) => void;
};

/**
 * A custom theme is materialized to a real file and edited in the code editor.
 * Saving it re-ingests into the runtime store + applies live; the edit request
 * channel opens (or creates) the theme file for editing.
 */
export function useThemeFileEditing({ tabsRef, openFileTab }: Params) {
  useEffect(() => {
    type FileWrittenPayload = { path: string; source?: string };
    const ingest = createThemeFileIngest({
      snapshot: readCustomThemes,
      read: (path) => invoke("fs_read_file", {
        path, workspace: workspaceEnvForPath(path), versioned: true,
      }),
      parse: parseThemeFile,
      save: saveThemeFileSnapshot,
      invalid: (error) => console.warn("[oarlock] theme not applied:", error),
      failed: (error) => {
        console.warn("[oarlock] theme ingest failed:", error);
        toast.error("Theme file saved, but theme could not be applied", { description: String(error) });
      },
    });
    const unlistenPromise = getCurrentWebviewWindow().listen<FileWrittenPayload>(
      "fs:file-written", (event) => {
        if (event.payload.source === "editor" && isThemeFilePath(event.payload.path))
          void ingest.ingest(event.payload.path);
      },
    );
    return () => {
      ingest.dispose();
      void unlistenPromise.then((un) => un());
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | undefined;
    void onThemeEdit(async (req) => {
      try {
        const theme =
          req.action === "create"
            ? starterTheme()
            : (await listCustomThemes()).find((t) => t.id === req.id);
        if (!theme) return;
        if (req.action === "create") await saveCustomTheme(theme);
        const path = await themeFilePath(theme.id);
        const open = tabsRef.current.some(
          (t) => t.kind === "editor" && t.path === path,
        );
        const comparison = open
          ? await compareThemeFile(path, theme)
          : (await writeThemeFile(theme)).comparison;
        if (comparison === "different") {
          toast.warning("Existing theme file differs from the saved theme", {
            description: "The existing file was preserved and opened for editing.",
          });
        } else if (comparison === "unknown") {
          toast.warning("Could not compare the existing theme file", {
            description: "The file was preserved. Check it before saving changes.",
          });
        }
        void persistThemeId(theme.id);
        openFileTab(path);
        void getCurrentWebviewWindow().setFocus().catch(console.error);
      } catch (error) {
        toast.error("Could not open custom theme", {
          description: String(error),
        });
      }
    }).then((fn) => {
      if (alive) unsub = fn;
      else fn();
    });
    return () => {
      alive = false;
      unsub?.();
    };
  }, [openFileTab, tabsRef]);
}
