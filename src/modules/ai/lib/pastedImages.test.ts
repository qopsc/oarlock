import { describe, expect, it, vi } from "vitest";

const answer = vi.hoisted(() => ({ next: null as ArrayBuffer | Error | null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    if (command !== "ai_clipboard_snapshot") throw new Error(command);
    if (answer.next instanceof Error) throw answer.next;
    return answer.next;
  },
}));

import {
  clipboardImageFile,
  createPasteSource,
  pastedImages,
  pasteKeepsText,
  pasteNeedsClipboardImage,
  decodeClipboardSnapshot,
  readClipboardSnapshot,
} from "./pastedImages";

const png = new File([new Uint8Array([1])], "image.png", { type: "image/png" });
const txt = new File(["x"], "notes.txt", { type: "text/plain" });

it("consumes the middle-click hint once instead of suppressing the next image paste", () => {
  const source = createPasteSource();
  source.pointerDown(1, 100);
  expect(source.takePrimary(120)).toBe(true);
  expect(source.takePrimary(150)).toBe(false);
});

it("keyboard and other pointer gestures clear an unused middle-click hint", () => {
  const source = createPasteSource();
  source.pointerDown(1, 100);
  source.keyDown();
  expect(source.takePrimary(120)).toBe(false);
  for (const button of [0, 2]) {
    source.pointerDown(1, 100);
    source.pointerDown(button, 110);
    expect(source.takePrimary(120)).toBe(false);
  }
});

it("does not infer a primary paste without a recent gesture in the same event clock", () => {
  const source = createPasteSource();
  expect(source.takePrimary(0)).toBe(false);
  source.pointerDown(1, 100);
  expect(source.takePrimary(1100)).toBe(false);
  source.pointerDown(1, 100);
  expect(source.takePrimary(90)).toBe(false);
});

function clipboard(input: {
  files?: File[];
  items?: { kind: string; type: string; file: File | null }[];
  types?: string[];
}) {
  return {
    files: input.files ?? [],
    items: (input.items ?? []).map((i) => ({
      kind: i.kind,
      type: i.type,
      getAsFile: () => i.file,
    })),
    types: input.types ?? [],
  } as unknown as Pick<DataTransfer, "files" | "items" | "types">;
}

describe("pastedImages", () => {
  it("takes images from the pasted files", () => {
    expect(pastedImages(clipboard({ files: [png, txt] }))).toEqual([png]);
  });

  it("falls back to file items when files is empty", () => {
    expect(
      pastedImages(
        clipboard({
          items: [
            { kind: "string", type: "text/html", file: null },
            { kind: "file", type: "image/png", file: png },
          ],
        }),
      ),
    ).toEqual([png]);
  });

  it("finds nothing in a text paste", () => {
    expect(
      pastedImages(
        clipboard({
          items: [{ kind: "string", type: "text/plain", file: null }],
          types: ["text/plain"],
        }),
      ),
    ).toEqual([]);
  });
});

describe("pasteKeepsText", () => {
  it("lets text through alongside an attached image", () => {
    expect(pasteKeepsText(clipboard({ types: ["text/plain", "Files"] }))).toBe(
      true,
    );
    expect(pasteKeepsText(clipboard({ types: ["Files"] }))).toBe(false);
  });
});

// crynta/terax-ai#274: WebKitGTK lists a clipboard image as "Files" and hands
// over no file, so the app reads it.
describe("pasteNeedsClipboardImage", () => {
  it("uses native reads for image files but never for an image in the primary selection", () => {
    for (const data of [
      clipboard({ files: [png], types: ["Files"] }),
      clipboard({ items: [{ kind: "file", type: "image/png", file: png }] }),
      clipboard({ files: [png], types: ["text/plain", "Files"] }),
    ]) {
      expect(pasteNeedsClipboardImage(data, false)).toBe(true);
      expect(pasteNeedsClipboardImage(data, true)).toBe(false);
    }
  });
  it("reads the clipboard's image when the webview handed none", () => {
    expect(
      pasteNeedsClipboardImage(clipboard({ types: ["Files"] }), false),
    ).toBe(true);
    expect(pasteNeedsClipboardImage(clipboard({}), false)).toBe(true);
    expect(
      pasteNeedsClipboardImage(clipboard({ types: ["text/html"] }), false),
    ).toBe(true);
  });

  it("leaves text pastes, files and the primary selection alone", () => {
    expect(
      pasteNeedsClipboardImage(clipboard({ types: ["text/plain"] }), false),
    ).toBe(false);
    // A file copied in a file manager that is no image: never its icon.
    expect(
      pasteNeedsClipboardImage(
        clipboard({ files: [txt], types: ["Files"] }),
        false,
      ),
    ).toBe(false);
    expect(
      pasteNeedsClipboardImage(
        clipboard({
          items: [{ kind: "file", type: "text/plain", file: txt }],
          types: ["Files"],
        }),
        false,
      ),
    ).toBe(false);
    // A middle click pastes the primary selection, not the clipboard.
    expect(
      pasteNeedsClipboardImage(clipboard({ types: ["Files"] }), true),
    ).toBe(false);
  });
});

describe("clipboardImageFile", () => {
  it("is a PNG named like a pasted screenshot", () => {
    const file = clipboardImageFile(new Uint8Array([137, 80, 78, 71]), 42);
    expect(file.name).toBe("image.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(4);
    expect(file.lastModified).toBe(42);
  });
});

describe("native clipboard snapshots", () => {
  it("decodes pixels, file paths and empty snapshots without another read", async () => {
    answer.next = new Uint8Array([1, 137, 80, 78, 71]).buffer;
    const snapshot = await readClipboardSnapshot();
    expect(snapshot.kind).toBe("image");
    if (snapshot.kind === "image") {
      expect(snapshot.image.type).toBe("image/png");
      expect(snapshot.image.size).toBe(4);
    }
    const payload = new TextEncoder().encode(
      JSON.stringify(["/tmp/.env", "/tmp/é.png"]),
    );
    expect(
      decodeClipboardSnapshot(new Uint8Array([2, ...payload]).buffer),
    ).toEqual({ kind: "files", paths: ["/tmp/.env", "/tmp/é.png"] });
    expect(decodeClipboardSnapshot(new Uint8Array([0]).buffer)).toEqual({
      kind: "empty",
    });
  });
  it("surfaces failed or changed captures instead of silently falling back", async () => {
    answer.next = new Error("Clipboard changed");
    await expect(readClipboardSnapshot()).rejects.toThrow("Clipboard changed");
    for (const data of [
      [],
      [1],
      [5],
      [0, 1],
      [2, ...new TextEncoder().encode("[1]")],
    ])
      expect(() =>
        decodeClipboardSnapshot(new Uint8Array(data).buffer),
      ).toThrow();
  });
});
