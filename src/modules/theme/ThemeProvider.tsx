import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  DEFAULT_THEME_ID,
  setTheme as persistTheme,
  setThemeId as persistThemeId,
  type ThemePref,
} from "@/modules/settings/store";
import { applyTheme, clearTheme } from "./applyTheme";
import { readCustomThemes, watchCustomThemes } from "./customThemes";
import { mutatePreferences, readNativePreferences } from "@/modules/settings/nativePreferences";
import { toast } from "sonner";
import { reconcileThemeSelection } from "./reconcileThemeSelection";
import { SurfaceLayer } from "./SurfaceLayer";
import { getBuiltinTheme, getDefaultTheme } from "./themes";
import type { Theme } from "./types";

export type { Theme };

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultMode?: ThemePref;
};

type ThemeProviderState = {
  mode: ThemePref;
  resolvedMode: "dark" | "light";
  themeId: string;
  activeTheme: Theme;
  customThemes: Theme[];
  customThemesError: string | null;
  customThemesReady: boolean;
  retryCustomThemes: () => void;
  setMode: (mode: ThemePref) => void;
  setThemeId: (id: string) => void;
  /** Apply a theme transiently without persisting; null reverts to committed. */
  previewThemeId: (id: string | null) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

const FAST_PATH_KEY = "oarlock-ui-theme-shadow";
const FAST_PATH_THEME_ID = "oarlock-ui-theme-id-shadow";

function readFastMode(fallback: ThemePref): ThemePref {
  if (typeof window === "undefined") return fallback;
  const v = window.localStorage.getItem(FAST_PATH_KEY);
  return v === "dark" || v === "light" || v === "system" ? v : fallback;
}

function writeFastMode(t: ThemePref): void {
  try {
    window.localStorage.setItem(FAST_PATH_KEY, t);
  } catch {
    /* ignore */
  }
}

function readFastThemeId(): string {
  if (typeof window === "undefined") return DEFAULT_THEME_ID;
  return window.localStorage.getItem(FAST_PATH_THEME_ID) ?? DEFAULT_THEME_ID;
}

function writeFastThemeId(id: string): void {
  try {
    window.localStorage.setItem(FAST_PATH_THEME_ID, id);
  } catch {
    /* ignore */
  }
}

function resolveTheme(id: string, custom: Theme[]): Theme {
  return (
    custom.find((t) => t.id === id) ?? getBuiltinTheme(id) ?? getDefaultTheme()
  );
}

export function ThemeProvider({
  children,
  defaultMode = "system",
}: ThemeProviderProps) {
  const [mode, setModeState] = useState<ThemePref>(() =>
    readFastMode(defaultMode),
  );
  const [themeId, setThemeIdState] = useState<string>(() => readFastThemeId());
  const preferencesReady = usePreferencesStore((p) => p.hydrated && !p.syncing && !p.error);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  const [customThemesError, setCustomThemesError] = useState<string | null>(
    null,
  );
  const [customThemesReady, setCustomThemesReady] = useState(false);
  const [themeRetry, setThemeRetry] = useState(0);
  const retryCustomThemes = useCallback(() => setThemeRetry((n) => n + 1), []);
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window === "undefined"
      ? true
      : window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    let mode: ThemePref | undefined;
    let themeId: string | undefined;
    const apply = () => {
      const p = usePreferencesStore.getState();
      if (!p.hydrated) return;
      if (mode !== p.theme) {
        mode = p.theme;
        setModeState(mode);
        writeFastMode(mode);
      }
      if (themeId !== p.themeId) {
        themeId = p.themeId;
        setThemeIdState(themeId);
        writeFastThemeId(themeId);
      }
    };
    const stop = usePreferencesStore.subscribe(apply);
    void usePreferencesStore
      .getState()
      .init()
      .catch(() => {});
    apply();
    return stop;
  }, []);

  useEffect(() => {
    void themeRetry;
    let alive = true;
    let stop: (() => void) | undefined;
    setCustomThemesReady(false);
    const failed = (error: unknown) => {
      if (alive) {
        setCustomThemesError(String(error));
        setCustomThemesReady(false);
      }
    };
    void watchCustomThemes((snapshot) => {
      if (!alive) return;
      setCustomThemes(snapshot.themes);
      setCustomThemesError(null);
      setCustomThemesReady(true);
    }, failed)
      .then((unlisten) => {
        if (alive) stop = unlisten;
        else unlisten();
      })
      .catch(failed);
    return () => {
      alive = false;
      stop?.();
    };
  }, [themeRetry]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolvedMode: "dark" | "light" =
    mode === "system" ? (systemDark ? "dark" : "light") : mode;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolvedMode);
  }, [resolvedMode]);

  const effectiveId = previewId ?? themeId;
  const activeTheme = useMemo(
    () => resolveTheme(effectiveId, customThemes),
    [effectiveId, customThemes],
  );
  useEffect(() => {
    if (!preferencesReady || !customThemesReady || getBuiltinTheme(themeId) || customThemes.some((theme) => theme.id === themeId)) return;
    let alive = true;
    void reconcileThemeSelection(themeId, {
      preferences: readNativePreferences,
      themes: readCustomThemes,
      isBuiltin: (id) => !!getBuiltinTheme(id),
      persistDefault: (revision) => mutatePreferences({ kind: "themeselection", id: DEFAULT_THEME_ID }, revision),
      current: () => alive,
      notice: () => toast("Selected theme was deleted"),
    }).catch((error) => {
      if (alive) toast.error("Could not restore the default theme", { description: String(error) });
    });
    return () => { alive = false; };
  }, [themeId, customThemes, customThemesReady, preferencesReady]);
  useEffect(() => {
    if (activeTheme.id === DEFAULT_THEME_ID) {
      clearTheme();
      return;
    }
    applyTheme(activeTheme, resolvedMode);
  }, [activeTheme, resolvedMode]);

  const setMode = useCallback((next: ThemePref) => {
    // The revisioned preference snapshot is the authority, including for the
    // startup shadow. Failed writes leave the currently saved selection intact.
    void persistTheme(next).catch(() => {});
  }, []);

  const setThemeId = useCallback((id: string) => {
    setPreviewId(null);
    void persistThemeId(id).catch(() => {});
  }, []);

  const previewThemeId = useCallback((id: string | null) => {
    setPreviewId(id);
  }, []);

  const value = useMemo<ThemeProviderState>(
    () => ({
      mode,
      resolvedMode,
      themeId,
      activeTheme,
      customThemes,
      customThemesError,
      customThemesReady,
      retryCustomThemes,
      setMode,
      setThemeId,
      previewThemeId,
    }),
    [
      mode,
      resolvedMode,
      themeId,
      activeTheme,
      customThemes,
      customThemesError,
      customThemesReady,
      retryCustomThemes,
      setMode,
      setThemeId,
      previewThemeId,
    ],
  );

  return (
    <ThemeProviderContext.Provider value={value}>
      <SurfaceLayer />
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme(): ThemeProviderState {
  const ctx = useContext(ThemeProviderContext);
  if (!ctx) throw new Error("useTheme must be used within a <ThemeProvider>");
  return ctx;
}
