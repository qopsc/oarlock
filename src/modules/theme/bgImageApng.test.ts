import { expect, it, vi } from "vitest";
vi.mock("./inspectBackgroundImage", () => ({ inspectBackgroundImage: async (blob: Blob) => blob }));
import { importBgImageFromFile } from "./bgImageStore";

it("keeps APNG animation and records its actual media type", async () => {
  const png = new Uint8Array([
    137,80,78,71,13,10,26,10,
    0,0,0,13,73,72,68,82,...new Array(13).fill(0),0,0,0,0,
    0,0,0,8,97,99,84,76,...new Array(8).fill(0),0,0,0,0,
    0,0,0,0,73,68,65,84,0,0,0,0,
  ]);
  let stored: Blob | undefined;
  const open = () => {
    const request: { result: unknown; onsuccess?: () => void } = { result: null };
    request.result = { transaction: () => {
      const transaction: { oncomplete?: () => void; objectStore: () => { put: (blob: Blob) => void } } = {
        objectStore: () => ({ put: (blob) => { stored = blob; queueMicrotask(() => transaction.oncomplete?.()); } }),
      };
      return transaction;
    } };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  };
  vi.stubGlobal("indexedDB", { open });
  const decode = vi.fn();
  vi.stubGlobal("createImageBitmap", decode);
  try {
    const result = await importBgImageFromFile(new File([png], "animated.png", { type: "image/png" }));
    expect(result.blob.type).toBe("image/apng");
    expect(stored?.type).toBe("image/apng");
    expect(decode).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
