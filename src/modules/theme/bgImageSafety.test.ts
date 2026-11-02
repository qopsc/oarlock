import { afterEach, expect, it, vi } from "vitest";
const validation = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock("./inspectBackgroundImage", () => ({
  inspectBackgroundImage: validation.inspect,
}));
import { importBgImageFromFile } from "./bgImageStore";

afterEach(() => {
  vi.unstubAllGlobals();
  validation.inspect.mockReset();
});

it.each(["image/png", "image/gif"])(
  "refuses a disallowed %s before decoding or storing",
  async (type) => {
    validation.inspect.mockRejectedValue(
      new Error("Image dimensions exceed the limit"),
    );
    const decode = vi.fn();
    const open = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    vi.stubGlobal("indexedDB", { open });
    await expect(
      importBgImageFromFile(
        new File([new Uint8Array([1, 2, 3])], "image", { type }),
      ),
    ).rejects.toThrow("dimensions");
    expect(decode).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  },
);

it("hands a saved background back without inspecting it again at startup", async () => {
  const stored = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
  const data = {
    result: stored,
    onsuccess: undefined as (() => void) | undefined,
  };
  const opened = {
    result: {
      onclose: null,
      transaction: () => ({ objectStore: () => ({ get: () => data }) }),
    },
    onsuccess: undefined as (() => void) | undefined,
  };
  vi.stubGlobal("indexedDB", { open: () => opened });
  const { getBgImage } = await import("./bgImageStore");
  const result = getBgImage("old");
  opened.onsuccess?.();
  await vi.waitFor(() => expect(data.onsuccess).toBeTypeOf("function"));
  data.onsuccess?.();
  await expect(result).resolves.toBe(stored);
  expect(validation.inspect).not.toHaveBeenCalled();
});

it("decodes the inspected snapshot rather than reading the selected file again", async () => {
  const snapshot = new Blob([new Uint8Array([4, 5, 6])], { type: "image/png" });
  validation.inspect.mockResolvedValue(snapshot);
  const decode = vi.fn().mockRejectedValue(new Error("stop after capture"));
  vi.stubGlobal("createImageBitmap", decode);
  await expect(
    importBgImageFromFile(
      new File([new Uint8Array([1, 2, 3])], "image", { type: "image/png" }),
    ),
  ).rejects.toThrow("couldn't be decoded");
  expect(decode).toHaveBeenCalledWith(snapshot);
});

it("recognizes APNG data supplied with the usual image/png MIME type", async () => {
  const png = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82, ...new Array(13).fill(0), 0, 0, 0, 0,
    0, 0, 0, 8, 97, 99, 84, 76, ...new Array(8).fill(0), 0, 0, 0, 0,
    0, 0, 0, 0, 73, 68, 65, 84, 0, 0, 0, 0,
  ]);
  const { isAnimated } = await import("./bgImageStore");
  expect(await isAnimated(new Blob([png], { type: "image/png" }))).toBe(true);
});
