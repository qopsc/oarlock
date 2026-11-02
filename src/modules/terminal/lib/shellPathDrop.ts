import type { WorkspaceEnv } from "@/modules/workspace/env";
import { formatDroppedPaths, type DropShell } from "./quoteShellPath";

const MAX_PATHS = 256;
const MAX_BYTES = 64 * 1024;
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/;
const DRIVE = /^([A-Za-z]):[\\/](.*)$/;

export class DropRefusal extends Error {}

function targetPath(path: string, source: WorkspaceEnv, target: WorkspaceEnv) {
  if (source.kind === "local" && target.kind === "local") return path;
  if (source.kind === "wsl" && target.kind === "wsl") {
    if (source.distro !== target.distro || !path.startsWith("/"))
      throw new DropRefusal("Paths from another environment cannot be used in this terminal.");
    return path;
  }
  if (source.kind === "local" && target.kind === "wsl") {
    const drive = DRIVE.exec(path);
    if (!drive)
      throw new DropRefusal("This path has no equivalent inside the WSL terminal.");
    return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`;
  }
  throw new DropRefusal("Paths from another environment cannot be used in this terminal.");
}

/** One absolute path as the terminal's shell reaches it (unquoted). */
export function convertShellPath(
  path: string,
  source: WorkspaceEnv,
  target: WorkspaceEnv,
  dialect: DropShell,
  windows: boolean,
): string {
  if (!ABSOLUTE.test(path)) throw new DropRefusal("A path is not absolute.");
  const mapped = targetPath(path, source, target);
  return windows && target.kind === "local" && dialect === "posix"
    ? mapped.replace(/\\/g, "/")
    : mapped;
}

/** The text a drop inserts: paths converted for the terminal's environment and quoted for its shell. */
export function planShellDrop(
  paths: readonly string[],
  source: WorkspaceEnv,
  target: WorkspaceEnv,
  dialect: DropShell,
  windows: boolean,
): string {
  if (
    !paths.length ||
    paths.length > MAX_PATHS ||
    paths.reduce((sum, path) => sum + path.length, 0) > MAX_BYTES
  )
    throw new DropRefusal("A drop holds 1 to 256 paths of at most 65,536 characters in all.");
  try {
    return formatDroppedPaths(
      paths.map((path) => convertShellPath(path, source, target, dialect, windows)),
      dialect,
    );
  } catch (error) {
    throw new DropRefusal(error instanceof Error ? error.message : String(error));
  }
}

export type ShellDropRun = {
  paths: readonly string[];
  source: WorkspaceEnv;
  target: WorkspaceEnv;
  windows: boolean;
  /** The reserved input slot; calling it again after it ran does nothing. */
  finish: (action: () => void, size?: number) => void;
  atPrompt: () => Promise<boolean | null>;
  dialect: () => Promise<DropShell | null>;
  /** Shell integration confirmed a prompt for this shell (a WSL pane cannot be asked). */
  promptConfirmed: () => boolean;
  /** The terminal is still the one the drop was made on. */
  active: () => boolean;
  /** A command has started since the check (shell integration). */
  running: () => boolean;
  paste: (text: string) => void;
  refuse: (description: string) => void;
};

/**
 * Inserts dropped paths into a plain terminal. The caller has reserved the
 * input slot; every path out of here releases it exactly once.
 */
export async function runShellDrop(run: ShellDropRun): Promise<void> {
  const { finish } = run;
  try {
    if (run.target.kind === "wsl" && !run.promptConfirmed())
      return finish(() =>
        run.refuse("A WSL terminal takes dropped paths only once shell integration has reported its prompt."));
    const atPrompt = await run.atPrompt();
    if (atPrompt !== true)
      return finish(() =>
        run.refuse(atPrompt === false
          ? "A program is running in this terminal."
          : "Could not verify the terminal is at its prompt."));
    const dialect = await run.dialect();
    if (!dialect)
      return finish(() => run.refuse("This shell does not support dropped paths."));
    const text = planShellDrop(run.paths, run.source, run.target, dialect, run.windows);
    finish(() => {
      if (
        !run.active() ||
        run.running() ||
        (run.target.kind === "wsl" && !run.promptConfirmed())
      )
        run.refuse("The terminal changed before the dropped paths could be inserted.");
      else run.paste(text);
    }, text.length * 2);
  } catch (error) {
    finish(() => run.refuse(error instanceof Error ? error.message : String(error)));
  }
}
