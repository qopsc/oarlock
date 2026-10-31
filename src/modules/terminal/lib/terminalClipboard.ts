import {
  invalidateClipboardImage,
  readTerminalClipboardSnapshot,
} from "./terminalClipboardSnapshot";
export { readTerminalClipboardSnapshot } from "./terminalClipboardSnapshot";
import { ClipboardWrite } from "@/lib/clipboardWrite";
import { isTauri } from "@tauri-apps/api/core";

/**
 * What a terminal program puts on the clipboard: text, or an image (any type
 * the webview decodes) with the text to put there should it not decode.
 */
export type TerminalClipboardContent =
  | string
  | {
      readonly mime: string;
      readonly data: Uint8Array<ArrayBuffer>;
      readonly text?: string;
    };

// Match native clipboard_image.rs before allocating a conversion canvas.
const MAX_IMAGE_SIDE = 16_384;
const MAX_IMAGE_RGBA_BYTES = 512 * 1024 * 1024;

class ClipboardImageConversionError extends Error {}

function imageCannotDecode(error: unknown): boolean {
  return (
    error instanceof ClipboardImageConversionError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "image-decode")
  );
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

/** Puts an image on the clipboard, converted to PNG when it is another type. */
async function putImage(
  data: Uint8Array<ArrayBuffer>,
  mime: string,
  write: ClipboardWrite,
): Promise<void> {
  if (!isTauri()) throw new Error("Clipboard images need the app");
  await write.check();
  const png =
    mime.toLowerCase() === "image/png" ? data : await toPng(data, mime);
  await write.image(png);
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
    owner: AbortSignal,
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

/** Text or an image from a program, with text fallback only for decoding failures. */
export async function writeTerminalClipboardContent(
  content: TerminalClipboardContent,
  owner: AbortSignal,
): Promise<void> {
  const write = new ProgramClipboardWrite(content, owner);
  write.prepare();
  await write.run();
}

/** An image the webview decodes, as PNG. */
async function toPng(
  data: Uint8Array<ArrayBuffer>,
  mime: string,
): Promise<Uint8Array> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([data], { type: mime }));
  } catch (error) {
    throw new ClipboardImageConversionError(String(error));
  }
  try {
    if (
      bitmap.width > MAX_IMAGE_SIDE ||
      bitmap.height > MAX_IMAGE_SIDE ||
      bitmap.width * bitmap.height * 4 > MAX_IMAGE_RGBA_BYTES
    ) {
      throw new Error("the clipboard image is too large");
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No canvas to convert the image");
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("The image could not be converted");
    return new Uint8Array(await blob.arrayBuffer());
  } catch (error) {
    throw new ClipboardImageConversionError(String(error));
  } finally {
    bitmap.close();
  }
}
