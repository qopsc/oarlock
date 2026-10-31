import { writeClipboardText } from "@/lib/clipboardWrite";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { IS_MAC } from "@/lib/platform";

export const REVEAL_LABEL = IS_MAC
  ? "Reveal in Finder"
  : "Reveal in File Manager";

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await writeClipboardText(text);
  } catch {
    // Best-effort; ignore in environments without clipboard permission.
  }
}

export function relativePath(rootPath: string, path: string): string {
  if (path === rootPath) return ".";
  const prefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  return path;
}

export async function revealInFinder(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch (e) {
    console.error("revealItemInDir failed:", e);
  }
}
