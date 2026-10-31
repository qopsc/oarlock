import type { ThemeSnapshot } from "./customThemes";
import type { Theme } from "./types";

type FileRead = { kind: string; content?: string; version?: string };
type Parsed = { ok: true; theme: Theme } | { ok: false; error: string };
type Dependencies = {
  snapshot: () => Promise<ThemeSnapshot>;
  read: (path: string) => Promise<FileRead>;
  parse: (content: string) => Parsed;
  save: (theme: Theme, revision: number, path: string, version: string) => Promise<void>;
  invalid: (error: string) => void;
  failed: (error: unknown) => void;
};

/** Order reads per file and compare native revisions across windows. */
export function createThemeFileIngest(deps: Dependencies) {
  const generations = new Map<string, object>();
  let alive = true;
  const ingest = async (path: string) => {
    const generation = {};
    generations.set(path, generation);
    const current = () => alive && generations.get(path) === generation;
    try {
      let baseline = await deps.snapshot();
      for (let attempts = 0; attempts < 3 && current(); attempts++) {
        const file = await deps.read(path);
        if (!current() || file.kind !== "text" || typeof file.content !== "string") return;
        if (!file.version) throw new Error("Theme file identity is unavailable. Save again to retry.");
        const parsed = deps.parse(file.content);
        if (!parsed.ok) { deps.invalid(parsed.error); return; }
        try {
          await deps.save(parsed.theme, baseline.revision, path, file.version);
          return;
        } catch (error) {
          if (!current()) return;
          if (String(error).includes("THEME_FILE_CHANGED")) return;
          if (!String(error).includes("THEME_REVISION_CHANGED")) throw error;
          const next = await deps.snapshot();
          if (!current()) return;
          const themeFor = (snapshot: ThemeSnapshot) => snapshot.themes.find((theme) => theme.id === parsed.theme.id);
          if (JSON.stringify(themeFor(baseline)) !== JSON.stringify(themeFor(next))) return;
          baseline = next;
        }
      }
      if (current()) throw new Error("Theme settings kept changing. Save the file again to retry.");
    } catch (error) {
      if (current()) deps.failed(error);
    } finally {
      if (generations.get(path) === generation) generations.delete(path);
    }
  };
  return { ingest, dispose: () => { alive = false; generations.clear(); } };
}
