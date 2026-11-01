import { expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => native);
vi.mock("@/lib/networkPage", () => ({ networkPage: async () => "page" }));
import { inspectBackgroundImage } from "./inspectBackgroundImage";

it("sends the selected bytes for validation and reports rejection", async () => {
  native.invoke.mockRejectedValueOnce(
    new Error("Image dimensions exceed the limit"),
  );
  await expect(
    inspectBackgroundImage(new Blob([new Uint8Array([1, 2, 3])])),
  ).rejects.toThrow("dimensions");
  expect(native.invoke).toHaveBeenCalledWith(
    "background_image_inspect",
    new Uint8Array([1, 2, 3]),
    { headers: { "x-page-generation": "page" } },
  );
});

it("returns a snapshot of the exact bytes that were inspected", async () => {
  native.invoke.mockResolvedValueOnce(undefined);
  const source = new Blob([new Uint8Array([4, 5, 6])], { type: "image/png" });
  const snapshot = await inspectBackgroundImage(source);
  expect(snapshot.type).toBe("image/png");
  expect([...new Uint8Array(await snapshot.arrayBuffer())]).toEqual([4, 5, 6]);
  expect(native.invoke).toHaveBeenLastCalledWith(
    "background_image_inspect",
    new Uint8Array([4, 5, 6]),
    { headers: { "x-page-generation": "page" } },
  );
});
