import { networkPage } from "@/lib/networkPage";
import { invoke, isTauri } from "@tauri-apps/api/core";

/** Inspect encoded metadata before a browser decoder can allocate its pixels. */
export async function inspectBackgroundImage(blob: Blob): Promise<Blob> {
  if (!isTauri())
    throw new Error("Background image inspection requires the Oarlock app.");
  if (blob.size > 30 * 1024 * 1024)
    throw new Error("Image exceeds the 30 MiB inspection limit.");
  const page = await networkPage(new AbortController().signal);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength > 30 * 1024 * 1024)
    throw new Error("Image exceeds the 30 MiB inspection limit.");
  await invoke("background_image_inspect", bytes, {
    headers: { "x-page-generation": page },
  });
  return new Blob([bytes], { type: blob.type });
}
