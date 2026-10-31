import { invoke, isTauri } from "@tauri-apps/api/core";
import { networkPage } from "@/lib/networkPage";

export type ClipboardImageRequest = "never" | "always" | "if-empty";
export type TerminalClipboardSnapshot = {
  readonly revision: string;
  readonly text: string | null;
  readonly image: Uint8Array | null;
};
type CachedImage = { revision: string; at: number; image: Uint8Array | null };
let cached: CachedImage | null = null;
let expiry: ReturnType<typeof setTimeout> | null = null;
let imageTail: Promise<void> | null = null;
const unowned = new AbortController().signal;
const REUSE_MS = 1000;

export function invalidateClipboardImage(): void {
  cached = null;
  if (expiry !== null) clearTimeout(expiry);
  expiry = null;
}

export function decodeClipboardSnapshot(
  buffer: ArrayBuffer,
  known: CachedImage | null,
): {
  snapshot: TerminalClipboardSnapshot;
  imageStatus: string;
  focusRequired: boolean;
} {
  if (buffer.byteLength < 4) throw new Error("Incomplete clipboard snapshot");
  const size = new DataView(buffer).getUint32(0, true);
  if (size > buffer.byteLength - 4)
    throw new Error("Incomplete clipboard snapshot header");
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 4, size)),
  );
  if (
    !header ||
    typeof header.revision !== "string" ||
    (header.focusRequired !== undefined &&
      typeof header.focusRequired !== "boolean") ||
    !(header.text === null || typeof header.text === "string") ||
    !["png", "reuse", "empty", "omitted"].includes(header.image)
  ) {
    throw new Error("Invalid clipboard snapshot");
  }
  const payload = new Uint8Array(buffer, 4 + size);
  if ((header.image === "png") !== payload.byteLength > 0)
    throw new Error("Invalid clipboard image payload");
  let image: Uint8Array | null = null;
  if (header.image === "reuse") {
    if (!known || known.revision !== header.revision)
      throw new Error("Clipboard cache version mismatch");
    image = known.image;
  } else if (header.image === "png") {
    // Do not retain a large encoded text header through the small image cache.
    image = payload.slice();
  }
  return {
    snapshot: { revision: header.revision, text: header.text, image },
    imageStatus: header.image,
    focusRequired: header.focusRequired === true,
  };
}

/** Every reuse is checked natively; neither time nor local writes prove identity. */
export async function readTerminalClipboardSnapshot(
  image: ClipboardImageRequest = "never",
  primary = false,
  signal: AbortSignal = unowned,
): Promise<TerminalClipboardSnapshot> {
  signal.throwIfAborted();
  let lostFocus = typeof document === "undefined" || !document.hasFocus();
  const blur = () => {
    lostFocus = true;
  };
  const target = typeof window === "undefined" ? null : window;
  target?.addEventListener("blur", blur);
  const checkFocus = () => {
    if (lostFocus || !document.hasFocus()) {
      invalidateClipboardImage();
      throw new Error(
        "Clipboard read cancelled after keyboard focus changed. Focus this window and try again.",
      );
    }
  };
  try {
    return await queuedCapture(image, primary, signal, checkFocus);
  } finally {
    target?.removeEventListener("blur", blur);
  }
}

async function queuedCapture(
  image: ClipboardImageRequest,
  primary: boolean,
  signal: AbortSignal,
  checkFocus: () => void,
): Promise<TerminalClipboardSnapshot> {
  if (primary || image === "never")
    return capture(image, primary, signal, checkFocus);
  const previous = imageTail;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  imageTail = current;
  try {
    await previous;
    return await capture(image, primary, signal, checkFocus);
  } finally {
    release();
    if (imageTail === current) imageTail = null;
  }
}

async function capture(
  image: ClipboardImageRequest,
  primary: boolean,
  signal: AbortSignal,
  checkFocus: () => void,
): Promise<TerminalClipboardSnapshot> {
  signal.throwIfAborted();
  if (!isTauri()) {
    const text = primary
      ? null
      : ((await navigator.clipboard?.readText()) ?? "");
    signal.throwIfAborted();
    return { revision: "browser", text, image: null };
  }
  const age = cached ? Date.now() - cached.at : Infinity;
  const known =
    !primary && image !== "never" && age >= 0 && age < REUSE_MS ? cached : null;
  const pageGeneration = await networkPage(signal);
  signal.throwIfAborted();
  const response = await invoke<ArrayBuffer>("terminal_clipboard_snapshot", {
    pageGeneration,
    primary,
    image,
    knownImageRevision: known?.revision ?? null,
  });
  signal.throwIfAborted();
  const { snapshot, imageStatus, focusRequired } = decodeClipboardSnapshot(
    response,
    known,
  );
  if (focusRequired) checkFocus();
  if (!primary && imageStatus !== "omitted") {
    invalidateClipboardImage();
    cached = {
      revision: snapshot.revision,
      image: snapshot.image,
      at: imageStatus === "reuse" && known ? known.at : Date.now(),
    };
    if (snapshot.image !== null)
      expiry = setTimeout(
        invalidateClipboardImage,
        Math.max(0, REUSE_MS - (Date.now() - cached.at)),
      );
  }
  return snapshot;
}
