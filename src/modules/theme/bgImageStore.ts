import { inspectBackgroundImage } from "./inspectBackgroundImage";

const DB_NAME = "oarlock-bg-images";
const STORE = "images";
const VERSION = 1;
const STAGED_IMAGE = /^oarlock-stage-v1-(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        if (dbPromise === p) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked by another tab"));
  }).catch((e) => {
    if (dbPromise === p) dbPromise = null;
    throw e;
  });
  dbPromise = p;
  return p;
}

async function putBgImage(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "QuotaExceededError") {
      throw new Error(
        "Not enough storage to save this image. Remove unused themes or backgrounds and try again.",
      );
    }
    throw e;
  }
}

export async function getBgImage(id: string): Promise<Blob | null> {
  const db = await openDb();
  const blob = await new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  // Inspected when it was imported; a stored blob is not copied over IPC on every start.
  return blob;
}

export async function deleteBgImage(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Image deletion was aborted"));
  });
}

/** Only our dated import keys are candidates; legacy and unrelated data remain untouched. */
export function isStaleBgImage(key: IDBValidKey, now: number): key is string {
  if (typeof key !== "string") return false;
  const match = STAGED_IMAGE.exec(key);
  return !!match && Number(match[1]) <= now - 60_000;
}
export async function staleBgImages(now: number): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result.filter((key) => isStaleBgImage(key, now)) as string[]);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
}

const MAX_DIM = 2560;
const JPEG_QUALITY = 0.88;
const MAX_STATIC_BYTES = 30 * 1024 * 1024;
const MAX_ANIMATED_BYTES = 10 * 1024 * 1024;
const WEBP_SNIFF_BYTES = 64;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export async function isAnimated(file: Blob): Promise<boolean> {
  const t = file.type.toLowerCase();
  if (t === "image/gif" || t === "image/apng") return true;
  if (t === "image/png") {
    const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (signature.length !== 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => signature[index] === value)) return false;
    let offset = 8;
    for (let chunks = 0; chunks < 1024 && offset + 12 <= file.size; chunks++) {
      const header = new Uint8Array(await file.slice(offset, offset + 8).arrayBuffer());
      if (header.length !== 8) return false;
      const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0);
      if (length > file.size - offset - 12) return false;
      const tag = String.fromCharCode(...header.subarray(4, 8));
      if (tag === "acTL") return true;
      if (tag === "IDAT") return false;
      offset += length + 12;
    }
    throw new Error("PNG image metadata is too complex or incomplete.");
  }
  if (t !== "image/webp") return false;
  const head = new Uint8Array(
    await file.slice(0, WEBP_SNIFF_BYTES).arrayBuffer(),
  );
  if (
    head.length < 30 ||
    head[0] !== 0x52 || head[1] !== 0x49 || head[2] !== 0x46 || head[3] !== 0x46 ||
    head[8] !== 0x57 || head[9] !== 0x45 || head[10] !== 0x42 || head[11] !== 0x50
  ) return false;
  if (
    head[12] === 0x56 && head[13] === 0x50 && head[14] === 0x38 && head[15] === 0x58
  ) {
    return (head[20] & 0x02) !== 0;
  }
  return false;
}

export async function importBgImageFromFile(
  file: File,
): Promise<{ id: string; blob: Blob }> {
  if (!file.type.startsWith("image/")) {
    throw new Error("This file isn't an image.");
  }
  const id = `oarlock-stage-v1-${Date.now()}-${crypto.randomUUID()}`;
  if (file.size > MAX_STATIC_BYTES) {
    throw new Error(
      `Images are limited to 30 MB. This one is ${formatBytes(file.size)}.`,
    );
  }
  // Keep the exact bytes inspected by native code for both classification and decoding.
  const snapshot = await inspectBackgroundImage(file);
  const animated = await isAnimated(snapshot);
  const limit = animated ? MAX_ANIMATED_BYTES : MAX_STATIC_BYTES;
  if (file.size > limit) {
    const limitMb = Math.round(limit / 1024 / 1024);
    throw new Error(
      animated
        ? `Animated images are limited to ${limitMb} MB to keep things smooth. This one is ${formatBytes(file.size)}.`
        : `Images are limited to ${limitMb} MB. This one is ${formatBytes(file.size)}.`,
    );
  }
  if (animated) {
    const type = snapshot.type.toLowerCase() === "image/png" ? "image/apng" : snapshot.type;
    const blob = snapshot.slice(0, snapshot.size, type);
    await putBgImage(id, blob);
    return { id, blob };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(snapshot);
  } catch {
    throw new Error("This image couldn't be decoded. Try a different file.");
  }
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_DIM / Math.max(width, height));
  const targetW = Math.max(1, Math.round(width * scale));
  const targetH = Math.max(1, Math.round(height * scale));
  try {
    const blob = await encodeJpeg(bitmap, targetW, targetH);
    await putBgImage(id, blob);
    return { id, blob };
  } finally {
    bitmap.close();
  }
}

async function encodeJpeg(
  bitmap: ImageBitmap,
  w: number,
  h: number,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined") {
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext("2d");
    if (!ctx) throw new Error("offscreen 2D context unavailable");
    ctx.drawImage(bitmap, 0, 0, w, h);
    return off.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2D context unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  try {
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("failed to encode image"))),
        "image/jpeg",
        JPEG_QUALITY,
      );
    });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
