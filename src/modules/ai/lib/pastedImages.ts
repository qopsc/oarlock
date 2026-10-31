import { invoke } from "@tauri-apps/api/core";

type Clipboard = Pick<DataTransfer, "files" | "items" | "types">;

/** One middle-click gesture can identify one primary-selection paste. */
export function createPasteSource() {
  let middle: number | null = null;
  return {
    pointerDown(button: number, time: number) {
      middle = button === 1 ? time : null;
    },
    keyDown() {
      middle = null;
    },
    takePrimary(time: number) {
      const started = middle;
      middle = null;
      return started !== null && time >= started && time - started < 1000;
    },
  };
}

/**
 * Images on a pasted clipboard, such as a screenshot. WebKit fills either
 * `files` or only `items` depending on the source, so both are read.
 */
export function pastedImages(data: Clipboard): File[] {
  const images = Array.from(data.files).filter((f) =>
    f.type.startsWith("image/"),
  );
  if (images.length > 0) return images;
  const fromItems: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  return fromItems;
}

/** Text on the clipboard still pastes into the composer; images attach. */
export function pasteKeepsText(data: Clipboard): boolean {
  return Array.from(data.types).includes("text/plain");
}

/**
 * Whether the app reads the clipboard's image itself. WebKitGTK lists an image on the clipboard
 * (a screenshot) as "Files" but hands over no file; WebKit on macOS and
 * WebView2 hand it over. A paste from the primary selection (a middle click
 * on Linux) never does: it does not paste the clipboard.
 */
export function pasteNeedsClipboardImage(
  data: Clipboard,
  fromPrimarySelection: boolean,
): boolean {
  if (fromPrimarySelection) return false;
  // Browser image File objects identify the paste, but native code owns its reads.
  if (pastedImages(data).length > 0) return true;
  if (data.files.length > 0) return false;
  if (Array.from(data.items).some((item) => item.kind === "file")) return false;
  return !pasteKeepsText(data);
}

/** The clipboard's image as a file to attach (PNG, as the app reads it). */
export function clipboardImageFile(png: Uint8Array, now: number): File {
  return new File([png as Uint8Array<ArrayBuffer>], "image.png", {
    type: "image/png",
    lastModified: now,
  });
}

export type ClipboardSnapshot =
  | { kind: "files"; paths: string[] }
  | { kind: "image"; image: File }
  | { kind: "empty" };

export function decodeClipboardSnapshot(
  buffer: ArrayBuffer,
): ClipboardSnapshot {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0 && bytes.length === 1) return { kind: "empty" };
  if (bytes[0] === 1 && bytes.length > 1)
    return {
      kind: "image",
      image: clipboardImageFile(bytes.subarray(1), Date.now()),
    };
  if (bytes[0] === 2) {
    const paths: unknown = JSON.parse(
      new TextDecoder().decode(bytes.subarray(1)),
    );
    if (Array.isArray(paths) && paths.every((path) => typeof path === "string"))
      return { kind: "files", paths };
  }
  throw new Error("Invalid clipboard snapshot");
}

/** One native capture; changed/unavailable clipboards surface as errors. */
export async function readClipboardSnapshot(): Promise<ClipboardSnapshot> {
  return decodeClipboardSnapshot(
    await invoke<ArrayBuffer>("ai_clipboard_snapshot"),
  );
}
