import type { PreferenceSnapshot } from "@/modules/settings/nativePreferences";

type Shader = { name: string; source: string };
type ShaderFile = { name: string; size: number; text: () => Promise<string> };
type Deps = {
  snapshot: () => Promise<PreferenceSnapshot>;
  validate: (source: string) => Promise<string | null>;
  save: (shader: Shader, revision: number) => Promise<void>;
  remove: () => Promise<void>;
  error: (message: string | null) => void;
  maxBytes: number;
};

// A reopened Settings view must wait for writes dispatched by its predecessor.
let shaderWrites: Promise<unknown> = Promise.resolve();

/** Owns the latest selection and serializes writes made by this settings view. */
export class ShaderSelection {
  private generation = 0;
  private alive = true;
  constructor(private readonly deps: Deps) {}
  private current(generation: number): boolean { return this.alive && this.generation === generation; }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = shaderWrites.catch(() => {}).then(work);
    shaderWrites = next;
    return next;
  }
  async choose(file: ShaderFile | undefined): Promise<void> {
    const generation = ++this.generation;
    this.deps.error(null);
    if (!file) return;
    if (file.size > this.deps.maxBytes) {
      this.deps.error(`${file.name}: larger than 256 KiB`);
      return;
    }
    try {
      await shaderWrites.catch(() => {});
      if (!this.current(generation)) return;
      let snapshot = await this.deps.snapshot();
      if (!this.current(generation)) return;
      const source = await file.text();
      if (!this.current(generation)) return;
      const error = await this.deps.validate(source);
      if (!this.current(generation)) return;
      if (error) { this.deps.error(`${file.name}:\n${error}`); return; }
      for (let attempt = 0; attempt < 3 && this.current(generation); attempt++) {
        try {
          await this.enqueue(async () => {
            if (this.current(generation)) await this.deps.save({ name: file.name, source }, snapshot.revision);
          });
          return;
        } catch (error) {
          if (!this.current(generation)) return;
          if (!String(error).includes("PREFERENCES_REVISION_CHANGED")) throw error;
          const next = await this.deps.snapshot();
          if (JSON.stringify(next.values.terminalCustomShader) !== JSON.stringify(snapshot.values.terminalCustomShader)) return;
          snapshot = next;
        }
      }
      if (this.current(generation)) throw new Error("Preferences kept changing. Choose the shader again.");
    } catch (error) {
      if (this.current(generation)) this.deps.error(`${file.name}: ${String(error)}`);
    }
  }
  async reset(): Promise<void> {
    const generation = ++this.generation;
    this.deps.error(null);
    try {
      // A confirmed removal remains requested even if Settings closes while
      // an earlier write is finishing. Later selections wait behind it.
      await this.enqueue(() => this.deps.remove());
    } catch (error) {
      if (this.current(generation)) this.deps.error(String(error));
    }
  }
  dispose(): void { this.alive = false; this.generation += 1; }
}
