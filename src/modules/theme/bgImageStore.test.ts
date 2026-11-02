import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("reports a deleted-image transaction that aborts without an error event", async () => {
  const transaction: {
    error: Error | null;
    onabort?: () => void;
    objectStore: () => { delete: () => void };
  } = {
    error: null,
    objectStore: () => ({ delete: () => undefined }),
  };
  const request: { result: unknown; onsuccess?: () => void } = {
    result: { transaction: () => transaction },
  };
  vi.stubGlobal("indexedDB", { open: () => request });
  const { deleteBgImage } = await import("./bgImageStore");
  const deletion = deleteBgImage("image");
  request.onsuccess?.();
  await vi.waitFor(() => expect(transaction.onabort).toBeTypeOf("function"));
  transaction.onabort?.();
  await expect(deletion).rejects.toThrow("aborted");
});
