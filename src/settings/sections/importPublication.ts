import type { PreferenceSnapshot } from "@/modules/settings/nativePreferences";

export type ImportPhase = "idle" | "preparing" | "saving";

/** A view may cancel preparation; an accepted native publication is atomic. */
export class ImportGate {
  private generation = 0;
  private phase: ImportPhase = "idle";
  private alive = true;
  constructor(private readonly changed: (phase: ImportPhase) => void) {}
  private set(phase: ImportPhase) { this.phase = phase; if (this.alive) this.changed(phase); }
  begin(): number | null {
    if (!this.alive || this.phase === "saving") return null;
    this.generation += 1;
    this.set("preparing");
    return this.generation;
  }
  current(ticket: number): boolean { return this.alive && this.generation === ticket && this.phase === "preparing"; }
  save(ticket: number): boolean {
    if (!this.current(ticket)) return false;
    this.set("saving");
    return true;
  }
  cancel(): boolean {
    if (this.phase === "saving") return false;
    this.generation += 1;
    this.set("idle");
    return true;
  }
  finish(ticket: number): void { if (this.generation === ticket) this.set("idle"); }
  dispose(): void {
    if (this.phase !== "saving") this.generation += 1;
    this.alive = false;
  }
}

type BackgroundDeps<FileValue> = {
  snapshot: () => Promise<PreferenceSnapshot>;
  latest: () => Promise<PreferenceSnapshot>;
  importFile: (file: FileValue) => Promise<{ id: string }>;
  publish: (id: string | null, revision?: number) => Promise<void>;
  removeFile: (id: string) => Promise<void>;
  withLock?: <T>(work: () => Promise<T>) => Promise<T>;
  cleanup?: () => Promise<void>;
};
export type BackgroundOutcome = "saved" | "cancelled" | "superseded";

type ThemeDeps<Theme> = {
  snapshot: () => Promise<PreferenceSnapshot>;
  prepare: () => Promise<{ themes: Theme[]; errors: string[] }>;
  save: (themes: Theme[]) => Promise<void>;
  select: (theme: Theme, revision: number) => Promise<void>;
};

export async function importThemes<Theme>(gate: ImportGate, deps: ThemeDeps<Theme>): Promise<{
  outcome: "saved" | "empty" | "cancelled" | "superseded";
  errors: string[];
}> {
  const ticket = gate.begin();
  if (ticket === null) return { outcome: "cancelled", errors: [] };
  let publishing = false;
  try {
    const before = await deps.snapshot();
    if (!gate.current(ticket)) return { outcome: "cancelled", errors: [] };
    const result = await deps.prepare();
    if (!gate.current(ticket)) return { outcome: "cancelled", errors: [] };
    if (result.themes.length === 0) return { outcome: "empty", errors: result.errors };
    // Saving the catalog may finish after Cancel; it must not select a theme.
    try { await deps.save(result.themes); }
    catch (error) {
      if (!gate.current(ticket)) return { outcome: "cancelled", errors: [] };
      throw error;
    }
    if (!gate.save(ticket)) return { outcome: "cancelled", errors: [] };
    publishing = true;
    try {
      await deps.select(result.themes[0], before.revision);
    } catch (error) {
      if (String(error).includes("PREFERENCES_REVISION_CHANGED"))
        return { outcome: "superseded", errors: result.errors };
      throw error;
    }
    return { outcome: "saved", errors: result.errors };
  } catch (error) {
    if (!publishing && !gate.current(ticket)) return { outcome: "cancelled", errors: [] };
    throw error;
  } finally { gate.finish(ticket); }
}

/** Candidate bytes remain private until the two background fields commit together. */
export async function importBackground<FileValue>(
  file: FileValue, gate: ImportGate, deps: BackgroundDeps<FileValue>,
): Promise<BackgroundOutcome> {
  const ticket = gate.begin();
  if (ticket === null) return "cancelled";
  let candidate: string | null = null;
  let safeToRemove = false;
  let publishing = false;
  try {
    const run = async (): Promise<BackgroundOutcome> => {
      if (!gate.current(ticket)) return "cancelled";
      await deps.cleanup?.();
      if (!gate.current(ticket)) return "cancelled";
      const before = await deps.snapshot();
      if (!gate.current(ticket)) return "cancelled";
      candidate = (await deps.importFile(file)).id;
      safeToRemove = true;
      if (!gate.save(ticket)) return "cancelled";
      publishing = true;
      try {
        // A transport failure can have an unknown outcome; retain the candidate
        // unless native explicitly reports that the update did not commit.
        safeToRemove = false;
        await deps.publish(candidate, before.revision);
      } catch (error) {
        if (String(error).includes("BACKGROUND_NOT_COMMITTED") || String(error).includes("PREFERENCES_REVISION_CHANGED")) {
          safeToRemove = true;
          if (String(error).includes("PREFERENCES_REVISION_CHANGED")) return "superseded";
        }
        throw error;
      }
      const previous = before.values.backgroundImageId;
      if (typeof previous === "string" && previous !== candidate) {
        try {
          const now = await deps.latest();
          if (now.values.backgroundImageId !== previous) await deps.removeFile(previous);
        } catch { /* keep unused bytes if safe cleanup cannot be verified */ }
      }
      return "saved";
    };
    return await (deps.withLock ? deps.withLock(run) : run());
  } catch (error) {
    if (!publishing && !gate.current(ticket)) return "cancelled";
    throw error;
  } finally {
    if (safeToRemove && candidate) await deps.removeFile(candidate).catch(() => {});
    gate.finish(ticket);
  }
}

/** Removal is an explicit selection and must finish after publication starts. */
export async function removeBackground<FileValue>(gate: ImportGate, deps: BackgroundDeps<FileValue>): Promise<boolean> {
  gate.cancel();
  const ticket = gate.begin();
  if (ticket === null) return false;
  try {
    const before = await deps.snapshot();
    if (!gate.save(ticket)) return false;
    await deps.publish(null, before.revision);
    const previous = before.values.backgroundImageId;
    if (typeof previous === "string") {
      try {
        const now = await deps.latest();
        if (now.values.backgroundImageId !== previous) await deps.removeFile(previous);
      } catch { /* preserving an unused image is safer than deleting an active one */ }
    }
    return true;
  } finally { gate.finish(ticket); }
}
