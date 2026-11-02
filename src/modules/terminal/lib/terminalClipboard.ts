import {
  invalidateClipboardImage,
  readTerminalClipboardSnapshot,
} from "./terminalClipboardSnapshot";
export { readTerminalClipboardSnapshot } from "./terminalClipboardSnapshot";
import { ClipboardWrite } from "@/lib/clipboardWrite";
import { isTauri } from "@tauri-apps/api/core";

/**
 * What a terminal program puts on the clipboard: text, or an image with the
 * text to put there should it not decode.
 */
export type TerminalClipboardContent =
  | string
  | {
      readonly mime: string;
      readonly data: Uint8Array<ArrayBuffer>;
      readonly text?: string;
    };

function imageCannotDecode(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "image-decode"
  );
}

/** Policy refusals must be visible even for writes requested by a program. */
export function clipboardImagePolicyMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error))
    return null;
  if (error.code !== "image-limit" && error.code !== "image-unsupported")
    return null;
  return "message" in error && typeof error.message === "string"
    ? error.message
    : "Clipboard image was refused.";
}

export async function readTerminalClipboard(): Promise<string> {
  try {
    return (await readTerminalClipboardSnapshot()).text ?? "";
  } catch {
    return "";
  }
}

export async function writeTerminalClipboard(text: string): Promise<void> {
  invalidateClipboardImage();
  const write = new ClipboardWrite();
  write.prepare();
  try {
    await write.text(text);
  } finally {
    write.dispose();
    invalidateClipboardImage();
  }
}

/** Linux primary selection (copy-on-select, middle-click paste). */
export async function writePrimarySelection(text: string): Promise<void> {
  if (!isTauri() || !text) return;
  const write = new ClipboardWrite(true);
  write.prepare();
  try {
    await write.text(text);
  } catch {
    /* unsupported display/selection */
  } finally {
    write.dispose();
  }
}

/** The Linux primary selection, or null where it is unsupported. */
export async function readPrimarySelection(): Promise<string | null> {
  try {
    return (await readTerminalClipboardSnapshot("never", true)).text;
  } catch {
    return null;
  }
}

/** Image reuse always verifies the native clipboard version. */
export async function readClipboardImage(): Promise<Uint8Array | null> {
  return (await readTerminalClipboardSnapshot("always")).image;
}

/** Puts a supported image on the clipboard through bounded native decoding. */
async function putImage(
  data: Uint8Array<ArrayBuffer>,
  mime: string,
  write: ClipboardWrite,
): Promise<void> {
  if (!isTauri()) throw new Error("Clipboard images need the app");
  const format = mime.toLowerCase();
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(format))
    throw Object.assign(
      new Error(
        "Unsupported clipboard image format. Use PNG, JPEG, GIF, or WebP.",
      ),
      { code: "image-unsupported" },
    );
  await write.check();
  await write.image(data, format);
}

export async function writeClipboardImage(
  data: Uint8Array<ArrayBuffer>,
  mime: string,
): Promise<void> {
  invalidateClipboardImage();
  const write = new ClipboardWrite();
  write.prepare();
  try {
    await putImage(data, mime, write);
  } finally {
    write.dispose();
    invalidateClipboardImage();
  }
}

/** One program write, prepared before it waits behind another conversion. */
export class ProgramClipboardWrite {
  private readonly write: ClipboardWrite;
  constructor(
    private readonly content: TerminalClipboardContent,
    private readonly owner: AbortSignal,
    private readonly primary = false,
  ) {
    this.write = new ClipboardWrite(primary, owner);
  }
  prepare(): void {
    this.write.prepare();
  }
  dispose(): void {
    this.write.dispose();
  }
  policyMessage(error: unknown): string | null {
    return this.owner.aborted ? null : clipboardImagePolicyMessage(error);
  }
  async run(): Promise<void> {
    invalidateClipboardImage();
    try {
      if (typeof this.content === "string") {
        if (!this.primary || this.content) await this.write.text(this.content);
      } else {
        try {
          await putImage(this.content.data, this.content.mime, this.write);
        } catch (error) {
          if (this.content.text === undefined || !imageCannotDecode(error))
            throw error;
          await this.write.text(this.content.text);
        }
      }
    } finally {
      this.dispose();
      invalidateClipboardImage();
    }
  }
}

/** Surface policy refusals while allowing the queue to continue after failure. */
export async function runProgramClipboardWrite(
  write: ProgramClipboardWrite,
  notify: (message: string) => void,
): Promise<void> {
  try {
    await write.run();
  } catch (error) {
    const message = write.policyMessage(error);
    if (message) notify(message);
    throw error;
  }
}

/** Text or an image from a program, with text fallback only for decoding failures. */
export async function writeTerminalClipboardContent(
  content: TerminalClipboardContent,
  owner: AbortSignal,
): Promise<void> {
  const write = new ProgramClipboardWrite(content, owner);
  write.prepare();
  await write.run();
}
