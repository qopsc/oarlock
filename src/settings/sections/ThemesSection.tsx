import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentNativePreferences, mutatePreferences, readNativePreferences } from "@/modules/settings/nativePreferences";
import { ImportGate, importBackground, importThemes, removeBackground, type ImportPhase } from "./importPublication";
import { cleanupBackgroundImports, withBackgroundImportLock } from "./backgroundCleanup";
import {
  EDITOR_THEME_AUTO,
  EDITOR_THEME_LABELS,
  EDITOR_THEME_MODE,
  EDITOR_THEMES,
  type EditorThemePref,
  setBackgroundBlur,
  setBackgroundOpacity,
  setEditorTheme,
  setTerminalOpacity,
  setWindowVibrancy,
  TERMINAL_OPACITY_MIN,
} from "@/modules/settings/store";
import { currentPlatform } from "@/modules/settings/terminalBehavior";
import { useTheme } from "@/modules/theme";
import { deleteThemeSelection } from "@/modules/theme/themeDeletion";
import {
  deleteBgImage,
  importBgImageFromFile,
  staleBgImages,
} from "@/modules/theme/bgImageStore";
import {
  deleteCustomTheme,
  createImportedThemes,
} from "@/modules/theme/customThemes";
import {
  deleteThemeFile,
  handOffThemeEdit,
  type ThemeEditRequest,
} from "@/modules/theme/themeFiles";
import { listBuiltinThemes } from "@/modules/theme/themes";
import { DEFAULT_THEME_ID, type Theme } from "@/modules/theme/types";
import { type Backdrop, getBackdropKind } from "@/modules/theme/vibrancy";
import { Edit02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";
import { ThemePastePanel } from "../components/ThemePastePanel";

// The parsers load on first use, so Settings opens without them.
const loadThemeImporter = () => import("@/modules/theme/schemes/importTheme");

export function ThemesSection() {
  const {
    themeId,
    setThemeId,
    resolvedMode,
    customThemes,
    customThemesError,
    customThemesReady,
    retryCustomThemes,
  } = useTheme();
  const builtinThemes = listBuiltinThemes();
  const themes = useMemo(
    () => [...builtinThemes, ...customThemes],
    [builtinThemes, customThemes],
  );
  const customIds = useMemo(
    () => new Set(customThemes.map((t) => t.id)),
    [customThemes],
  );

  const selectedTheme = useRef(themeId);
  selectedTheme.current = themeId;

  const [importError, setImportError] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [bgError, setBgError] = useState<string | null>(null);
  const [themePhase, setThemePhase] = useState<ImportPhase>("idle");
  const [bgPhase, setBgPhase] = useState<ImportPhase>("idle");
  const themeGate = useRef<ImportGate | null>(null);
  const bgGate = useRef<ImportGate | null>(null);
  useEffect(() => {
    const theme = new ImportGate(setThemePhase);
    const background = new ImportGate(setBgPhase);
    themeGate.current = theme;
    bgGate.current = background;
    return () => { theme.dispose(); background.dispose(); themeGate.current = null; bgGate.current = null; };
  }, []);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bgInputRef = useRef<HTMLInputElement | null>(null);

  // Editing happens in the main window's code editor, so Settings closes
  // (destroying its WebContent process) rather than hiding and staying resident.
  const startThemeEdit = (req: ThemeEditRequest) =>
    void handOffThemeEdit(req, () => getCurrentWindow().close());
  const onCreateTheme = () => startThemeEdit({ action: "create" });
  const onEditTheme = (id: string) => startThemeEdit({ action: "edit", id });

  const editorThemePref = usePreferencesStore((s) => s.editorTheme);
  const backgroundKind = usePreferencesStore((s) => s.backgroundKind);
  const backgroundImageId = usePreferencesStore((s) => s.backgroundImageId);
  const backgroundOpacity = usePreferencesStore((s) => s.backgroundOpacity);
  const backgroundBlur = usePreferencesStore((s) => s.backgroundBlur);
  const windowVibrancy = usePreferencesStore((s) => s.windowVibrancy);
  const terminalOpacity = usePreferencesStore((s) => s.terminalOpacity);

  const [backdrop, setBackdrop] = useState<Backdrop>("none");
  useEffect(() => {
    let alive = true;
    void getBackdropKind().then((k) => {
      if (alive) setBackdrop(k);
    });
    return () => {
      alive = false;
    };
  }, []);

  const initialPreferences = async () => {
    const snapshot = currentNativePreferences();
    if (!snapshot) throw new Error("Preferences are still loading. Retry when they are ready.");
    return snapshot;
  };
  const runThemeImport = async (prepare: () => Promise<{ themes: Theme[]; errors: string[] }>) => {
    const gate = themeGate.current;
    if (!gate || !customThemesReady) return false;
    setImportError(null);
    try {
      const result = await importThemes(gate, {
        snapshot: initialPreferences,
        prepare,
        save: createImportedThemes,
        select: (theme, revision) => mutatePreferences({ kind: "themeselection", id: theme.id }, revision),
      });
      if (result.outcome === "cancelled") return false;
      if (result.outcome === "superseded") {
        setImportError("Settings changed while importing, so the imported theme was not selected.");
        return false;
      }
      setImportError(result.errors.length ? result.errors.join("\n") : null);
      return result.outcome === "saved" && result.errors.length === 0;
    } catch (error) {
      setImportError(`Could not import the theme: ${String(error)}`);
      return false;
    }
  };
  const handleThemeFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const selected = Array.from(files);
    await runThemeImport(async () => {
      const { importThemeFiles } = await loadThemeImporter();
      return importThemeFiles(selected, themes.map((theme) => theme.id));
    });
  };
  const importText = (text: string) => runThemeImport(async () => {
    const { importThemeText } = await loadThemeImporter();
    const result = importThemeText(text, { takenIds: themes.map((theme) => theme.id) });
    return result.ok ? { themes: result.themes, errors: [] } : { themes: [], errors: [result.error] };
  });
  const closePaste = () => {
    if (themeGate.current?.cancel() !== false) setPasteOpen(false);
  };

  const onPickThemeFile = () => fileInputRef.current?.click();

  const onRemoveCustomTheme = async (id: string) => {
    try {
      await deleteThemeSelection(
        id,
        deleteCustomTheme,
        () => selectedTheme.current,
        () => setThemeId(DEFAULT_THEME_ID),
      );
      await deleteThemeFile(id);
    } catch (error) {
      setImportError(String(error));
    }
  };

  const onPickBgFile = () => bgInputRef.current?.click();

  const backgroundDeps = {
    snapshot: initialPreferences,
    latest: readNativePreferences,
    importFile: importBgImageFromFile,
    publish: (id: string | null, revision?: number) => mutatePreferences({ kind: "background", imageId: id }, revision),
    removeFile: deleteBgImage,
    withLock: withBackgroundImportLock,
    cleanup: () => cleanupBackgroundImports({
      stale: staleBgImages,
      snapshot: readNativePreferences,
      barrier: (snapshot) => mutatePreferences({
        kind: "themeselection",
        id: typeof snapshot.values.themeId === "string" ? snapshot.values.themeId : DEFAULT_THEME_ID,
      }, snapshot.revision),
      remove: deleteBgImage,
    }),
  };
  const handleBgFiles = async (files: FileList | null) => {
    if (!files?.length || !bgGate.current) return;
    const file = files[0];
    setBgError(null);
    if (!file.type.startsWith("image/")) {
      setBgError(`${file.name}: not an image`);
      return;
    }
    try {
      const result = await importBackground(file, bgGate.current, backgroundDeps);
      if (result === "superseded") setBgError("Settings changed while importing, so the new background was not selected.");
    } catch (error) {
      setBgError(error instanceof Error ? error.message : String(error));
    }
  };
  const onRemoveBackground = async () => {
    if (!bgGate.current) return;
    setBgError(null);
    try { await removeBackground(bgGate.current, backgroundDeps); }
    catch (error) {
      setBgError(String(error).includes("PREFERENCES_REVISION_CHANGED")
        ? "The background changed in another window. Try again."
        : error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Themes"
        description="Theme, background image, and customization."
      />

      {customThemesError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 p-3 text-sm"
        >
          <p>
            Custom themes could not be loaded. Your files have been preserved.
          </p>
          <p className="mt-1 break-words text-xs text-muted-foreground">
            {customThemesError}
          </p>
          <Button
            className="mt-2"
            variant="outline"
            onClick={retryCustomThemes}
          >
            Retry
          </Button>
        </div>
      ) : !customThemesReady ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading custom themes…
        </p>
      ) : null}

      {backdrop === "none" ? null : (
        <SettingRow
          title={backdrop === "mica" ? "Mica background" : "Window vibrancy"}
          description={
            backdrop === "mica"
              ? "Blend the header, status bar and gutters into the desktop wallpaper. Windows 11 only."
              : "Frost the header, status bar and gutters over what is behind the window. Panes stay solid."
          }
        >
          <Switch
            checked={windowVibrancy}
            onCheckedChange={(v) => void setWindowVibrancy(v)}
          />
        </SettingRow>
      )}

      <SettingRow
        title="Terminal opacity"
        description={terminalOpacityDescription(backdrop)}
      >
        <div className="flex w-40 items-center gap-2.5">
          <Slider
            value={[terminalOpacity]}
            min={TERMINAL_OPACITY_MIN}
            max={1}
            step={0.05}
            aria-label="Terminal opacity"
            onValueChange={(v) => void setTerminalOpacity(v[0] ?? 1)}
          />
          <span className="w-9 shrink-0 text-right tabular-nums text-[11px] text-muted-foreground">
            {Math.round(terminalOpacity * 100)}%
          </span>
        </div>
      </SettingRow>

      <div
        role="presentation"
        className="flex flex-col gap-2"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (themePhase === "saving") return;
          if (e.dataTransfer.files.length > 0) {
            void handleThemeFiles(e.dataTransfer.files);
            return;
          }
          const text = e.dataTransfer.getData("text/plain");
          if (text.trim() !== "") void importText(text);
        }}
      >
        <div className="flex items-center justify-between">
          <Label>Theme</Label>
          <div className="flex items-center gap-1.5">
            {themePhase === "saving" ? <span role="status" className="text-xs text-muted-foreground">Saving…</span> : null}
            {themePhase === "preparing" && !pasteOpen ? (
              <Button variant="ghost" size="sm" onClick={() => themeGate.current?.cancel()}>Cancel</Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px]"
              disabled={!customThemesReady}
              onClick={onCreateTheme}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={11} strokeWidth={2} />
              Create
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              title="Import a .oarlock-theme, or a Ghostty, iTerm2, Alacritty or Windows Terminal colour scheme"
              disabled={!customThemesReady || themePhase === "saving"}
              onClick={onPickThemeFile}
            >
              Import…
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={!customThemesReady || themePhase === "saving"}
              aria-expanded={pasteOpen}
              onClick={() => {
                setImportError(null);
                if (pasteOpen) closePaste(); else setPasteOpen(true);
              }}
            >
              Paste
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void handleThemeFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Import, paste or drop a .oarlock-theme, or a Ghostty, iTerm2,
          Alacritty or Windows Terminal colour scheme.
        </p>
        {pasteOpen ? (
          <ThemePastePanel
            onImport={importText}
            onClose={closePaste}
            saving={themePhase === "saving"}
          />
        ) : null}
        {importError ? (
          <div
            role="alert"
            className="whitespace-pre-line wrap-break-word rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive"
          >
            {importError}
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          {themes.map((t) => {
            const v =
              t.variants[resolvedMode] ?? t.variants.dark ?? t.variants.light;
            const c = v?.colors;
            const swatchBg = c?.background ?? "var(--background)";
            const swatchFg = c?.foreground ?? "var(--foreground)";
            const swatchAccent = c?.primary ?? c?.accent ?? "var(--accent)";
            const swatchMuted = c?.muted ?? "var(--muted)";
            const selected = themeId === t.id;
            const isCustom = customIds.has(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => { themeGate.current?.cancel(); setThemeId(t.id); }}
                className={cn(
                  "group flex items-center gap-3 rounded-lg border p-2.5 text-left transition-all",
                  selected
                    ? "border-foreground/60 ring-1 ring-foreground/20"
                    : "border-border/60 hover:border-border",
                )}
              >
                <div
                  className="flex h-10 w-14 shrink-0 items-center justify-center gap-1 rounded-md border border-border/40"
                  style={{ background: swatchBg }}
                >
                  <span
                    className="h-5 w-2 rounded-sm"
                    style={{ background: swatchAccent }}
                  />
                  <span
                    className="h-5 w-2 rounded-sm"
                    style={{ background: swatchFg, opacity: 0.7 }}
                  />
                  <span
                    className="h-5 w-2 rounded-sm"
                    style={{ background: swatchMuted }}
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12.5px] font-medium">
                    {t.name}
                  </span>
                  {t.description ? (
                    <span className="truncate text-[11px] text-muted-foreground">
                      {t.description}
                    </span>
                  ) : null}
                </div>
                {isCustom ? (
                  <span className="ml-1 flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                    <span
                      role="button"
                      aria-label={`Edit ${t.name}`}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (customThemesReady) onEditTheme(t.id);
                      }}
                    >
                      <HugeiconsIcon
                        icon={Edit02Icon}
                        size={12}
                        strokeWidth={1.75}
                      />
                    </span>
                    <span
                      role="button"
                      aria-label={`Remove ${t.name}`}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (customThemesReady) void onRemoveCustomTheme(t.id);
                      }}
                    >
                      ×
                    </span>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <Label>Editor theme</Label>
            <span className="text-[11px] text-muted-foreground">
              Syntax colors for the code editor. Auto follows the app theme.
            </span>
          </div>
          <Select
            value={editorThemePref}
            onValueChange={(v) => void setEditorTheme(v as EditorThemePref)}
          >
            <SelectTrigger size="sm" className="h-8 w-44 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EDITOR_THEME_AUTO} className="text-[12px]">
                Auto (match app theme)
              </SelectItem>
              <SelectSeparator />
              {[...EDITOR_THEMES]
                .sort(
                  (a, b) =>
                    (EDITOR_THEME_MODE[a] === resolvedMode ? 0 : 1) -
                    (EDITOR_THEME_MODE[b] === resolvedMode ? 0 : 1),
                )
                .map((id) => (
                  <SelectItem
                    key={id}
                    value={id}
                    disabled={EDITOR_THEME_MODE[id] !== resolvedMode}
                    className="text-[12px]"
                  >
                    {EDITOR_THEME_LABELS[id]}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div
        role="presentation"
        className="flex flex-col gap-2"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (bgPhase === "saving") return;
          void handleBgFiles(e.dataTransfer.files);
        }}
      >
        <div className="flex items-center justify-between">
          <Label>Background</Label>
          <div className="flex items-center gap-2">
            {backgroundKind === "image" && backgroundImageId ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                disabled={bgPhase === "saving"}
                onClick={() => void onRemoveBackground()}
              >
                Remove
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={bgPhase === "saving"}
              onClick={onPickBgFile}
            >
              {bgPhase === "saving" ? "Saving…" : backgroundKind === "image" ? "Replace image" : "Choose image"}
            </Button>
            {bgPhase === "preparing" ? (
              <Button variant="ghost" size="sm" onClick={() => bgGate.current?.cancel()}>Cancel</Button>
            ) : null}
            <input
              ref={bgInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                void handleBgFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        </div>
        {bgError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
            {bgError}
          </div>
        ) : null}
        {backgroundKind === "image" && backgroundImageId ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11.5px] text-muted-foreground">
                Opacity
              </span>
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {Math.round(backgroundOpacity * 100)}%
              </span>
            </div>
            <Slider
              value={[backgroundOpacity]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={(v) => void setBackgroundOpacity(v[0] ?? 0)}
            />
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[11.5px] text-muted-foreground">Blur</span>
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {backgroundBlur}px
              </span>
            </div>
            <Slider
              value={[backgroundBlur]}
              min={0}
              max={64}
              step={1}
              onValueChange={(v) => void setBackgroundBlur(v[0] ?? 0)}
            />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Drop an image here or pick one. Stored locally; doesn't affect the
            default look until set.
          </p>
        )}
      </div>
    </div>
  );
}

/** What lowering the terminal opacity shows, on this platform. */
function terminalOpacityDescription(backdrop: Backdrop): string {
  const base =
    "Let what is behind the window show through terminal backgrounds and the frame around them. Text and coloured cells stay solid; a theme's own transparency adds to this.";
  if (backdrop === "vibrancy") return `${base} Frosted while vibrancy is on.`;
  if (backdrop === "mica") return `${base} Mica shows through while it is on.`;
  return currentPlatform() === "linux" ? `${base} Needs a compositor.` : base;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
