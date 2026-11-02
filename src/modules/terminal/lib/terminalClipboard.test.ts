import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProgramClipboardWrite,
  readClipboardImage,
  readTerminalClipboard,
  runProgramClipboardWrite,
  writeClipboardImage,
  writeTerminalClipboard,
  writeTerminalClipboardContent as writeContent,
} from "./terminalClipboard";

const writeTerminalClipboardContent = (
  content: Parameters<typeof writeContent>[0],
  owner = new AbortController().signal,
) => writeContent(content, owner);
vi.mock("@/lib/networkPage", () => ({ networkPage: async () => "page" }));
const order = vi.hoisted(() => ({ next: 0, latest: "", revision: 0 }));
const imageHeaders = vi.hoisted(() => [] as (string | undefined)[]);
const native = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string>>(),
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => native);
const ipc = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: async (
    command: string,
    args: Record<string, unknown>,
    options?: { headers?: Record<string, string> },
  ) => {
    if (command === "clipboard_write_begin") {
      order.latest = String(++order.next);
      return Promise.resolve(order.latest);
    }
    if (command === "clipboard_write_cancel") {
      if (args.ticket === order.latest) order.latest = "";
      return Promise.resolve();
    }
    if (command === "clipboard_text_write") {
      if (args.ticket !== order.latest)
        return Promise.reject(new Error("superseded"));
      order.latest = "";
      await native.writeText(args.text as string);
      order.revision += 1;
      return;
    }
    if (command === "terminal_clipboard_snapshot") {
      const revision = String(order.revision);
      const text = (await native.readText()) ?? "";
      if (revision !== String(order.revision))
        throw new Error("Clipboard changed while reading");
      let image = "omitted";
      let png = new Uint8Array(0);
      if (
        !args.primary &&
        (args.image === "always" || (args.image === "if-empty" && !text))
      ) {
        if (args.knownImageRevision === revision) image = "reuse";
        else {
          png = new Uint8Array(
            (await ipc.invoke("clipboard_image_read")) as ArrayBuffer,
          );
          image = png.byteLength ? "png" : "empty";
        }
      }
      if (revision !== String(order.revision))
        throw new Error("Clipboard changed while reading");
      const header = new TextEncoder().encode(
        JSON.stringify({ revision, text, image }),
      );
      const frame = new Uint8Array(4 + header.length + png.length);
      new DataView(frame.buffer).setUint32(0, header.length, true);
      frame.set(header, 4);
      frame.set(png, 4 + header.length);
      return frame.buffer;
    }
    if (command === "clipboard_image_write")
      imageHeaders.push(options?.headers?.["x-clipboard-image-type"]);
    if (
      command === "clipboard_image_write" &&
      options?.headers?.["x-clipboard-ticket"] !== order.latest
    )
      return Promise.reject(new Error("superseded"));
    return args === undefined ? ipc.invoke(command) : ipc.invoke(command, args);
  },
}));
const web = { readText: vi.fn(), writeText: vi.fn() };

beforeEach(() => {
  vi.resetAllMocks();
  imageHeaders.length = 0;
  vi.stubGlobal("isTauri", true);
  vi.stubGlobal("navigator", { clipboard: web });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("terminal clipboard", () => {
  it.each(["Macintosh", "Windows NT", "X11; Linux"])(
    "uses native copy and paste in the %s application without WebKit prompts",
    async (userAgent) => {
      vi.stubGlobal("navigator", { userAgent, clipboard: web });
      native.readText.mockResolvedValue("external copy");
      await expect(readTerminalClipboard()).resolves.toBe("external copy");
      await writeTerminalClipboard("terminal selection");
      expect(native.writeText).toHaveBeenCalledWith("terminal selection");
      expect(web.readText).not.toHaveBeenCalled();
      expect(web.writeText).not.toHaveBeenCalled();
    },
  );

  it("does not fall back to permission-gated web reads after an IPC failure", async () => {
    native.readText.mockRejectedValue(new Error("clipboard busy"));
    await expect(readTerminalClipboard()).resolves.toBe("");
    expect(web.readText).not.toHaveBeenCalled();
    native.readText.mockResolvedValue("retry");
    await expect(readTerminalClipboard()).resolves.toBe("retry");
  });

  it("reports failed copies instead of signaling success", async () => {
    native.writeText.mockRejectedValue(new Error("clipboard busy"));
    await expect(writeTerminalClipboard("text")).rejects.toThrow(
      "clipboard busy",
    );
    expect(web.writeText).not.toHaveBeenCalled();
  });

  it("uses browser clipboard APIs in a browser preview", async () => {
    vi.stubGlobal("isTauri", false);
    web.readText.mockResolvedValue("web");
    await expect(readTerminalClipboard()).resolves.toBe("web");
    await writeTerminalClipboard("preview");
    expect(web.writeText).toHaveBeenCalledWith("preview");
    expect(native.readText).not.toHaveBeenCalled();
    expect(native.writeText).not.toHaveBeenCalled();
  });
});

describe("clipboard images", () => {
  const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);

  it("reads the image once for reads close together, none as null", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // A write first drops any read an earlier test left.
    await writeTerminalClipboard("");
    ipc.invoke.mockResolvedValue(png.slice().buffer);
    await expect(readClipboardImage()).resolves.toEqual(png);
    await expect(readClipboardImage()).resolves.toEqual(png);
    expect(ipc.invoke).toHaveBeenCalledTimes(1);
    expect(ipc.invoke).toHaveBeenCalledWith("clipboard_image_read");

    // A second later the clipboard is read again: it may have changed.
    vi.advanceTimersByTime(1000);
    ipc.invoke.mockResolvedValue(new ArrayBuffer(0));
    await expect(readClipboardImage()).resolves.toBeNull();
    // So it is after this app writes it.
    ipc.invoke.mockResolvedValue(png.slice().buffer);
    await writeTerminalClipboard("text");
    await expect(readClipboardImage()).resolves.toEqual(png);
    ipc.invoke.mockRejectedValue(new Error("no clipboard"));
    vi.advanceTimersByTime(1000);
    await expect(readClipboardImage()).rejects.toThrow("no clipboard");
  });

  it("writes a PNG as it is, and a program's image with its text to fall back on", async () => {
    ipc.invoke.mockResolvedValue(undefined);
    await writeClipboardImage(png, "image/PNG");
    expect(ipc.invoke).toHaveBeenCalledWith("clipboard_image_write", png);

    // Native decoding fails; a program-provided text alternative is used.
    ipc.invoke.mockRejectedValueOnce({ code: "image-decode", message: "bad image" });
    await writeTerminalClipboardContent({
      mime: "image/webp",
      data: png,
      text: "alt",
    });
    expect(native.writeText).toHaveBeenCalledWith("alt");
    ipc.invoke.mockRejectedValueOnce({ code: "image-decode", message: "bad image" });
    await expect(
      writeTerminalClipboardContent({ mime: "image/webp", data: png }),
    ).rejects.toThrow();
    await writeTerminalClipboardContent("plain");
    expect(native.writeText).toHaveBeenLastCalledWith("plain");
  });

  it.each(["image/jpeg", "image/gif", "image/webp"])("sends %s to native decoding without a webview bitmap", async (mime) => {
    const bitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", bitmap);
    ipc.invoke.mockResolvedValue(undefined);
    await writeClipboardImage(png, mime);
    expect(bitmap).not.toHaveBeenCalled();
    expect(ipc.invoke).toHaveBeenCalledWith("clipboard_image_write", png);
    expect(imageHeaders).toEqual([mime]);
  });
});

it("invalidates images read while a text clipboard write is still pending", async () => {
  await writeTerminalClipboard("");
  let finish!: () => void;
  native.writeText.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const writing = writeTerminalClipboard("new text");
  await vi.waitFor(() => expect(finish).toBeDefined());
  ipc.invoke.mockResolvedValueOnce(Uint8Array.of(1, 2, 3).buffer);
  await expect(readClipboardImage()).resolves.toEqual(Uint8Array.of(1, 2, 3));
  finish();
  await writing;
  ipc.invoke.mockResolvedValueOnce(new ArrayBuffer(0));
  await expect(readClipboardImage()).resolves.toBeNull();
});

it("does not replace an image with fallback text when the OS write fails", async () => {
  ipc.invoke.mockRejectedValue(new Error("clipboard busy"));
  await expect(
    writeTerminalClipboardContent({
      mime: "image/png",
      data: Uint8Array.of(1),
      text: "fallback",
    }),
  ).rejects.toThrow("clipboard busy");
  expect(native.writeText).not.toHaveBeenCalled();
});

it.each(["image-limit", "image-unsupported"])("does not silently replace a refused image with fallback text (%s)", async (code) => {
  const error = { code, message: "Clipboard image was refused." };
  ipc.invoke.mockRejectedValue(error);
  await expect(writeTerminalClipboardContent({ mime: "image/jpeg", data: Uint8Array.of(1), text: "alternative" })).rejects.toEqual(error);
  expect(native.writeText).not.toHaveBeenCalled();
});

it.each(["image/svg+xml", "image/png\ninvalid"])("refuses unsupported MIME type %s before IPC", async (mime) => {
  await expect(writeTerminalClipboardContent({ mime, data: Uint8Array.of(1), text: "alternative" }))
    .rejects.toMatchObject({ code: "image-unsupported" });
  expect(ipc.invoke).not.toHaveBeenCalledWith("clipboard_image_write", expect.anything());
  expect(native.writeText).not.toHaveBeenCalled();
});

it.each(["image-limit", "image-unsupported"])("reports a program image policy refusal visibly (%s)", async (code) => {
  const error = { code, message: "Clipboard image was refused." };
  ipc.invoke.mockRejectedValue(error);
  const notify = vi.fn();
  const write = new ProgramClipboardWrite({ mime: "image/webp", data: Uint8Array.of(1) }, new AbortController().signal);
  write.prepare();
  await expect(runProgramClipboardWrite(write, notify)).rejects.toEqual(error);
  expect(notify).toHaveBeenCalledExactlyOnceWith(error.message);
});

it("does not report stale policy refusals after terminal cancellation", () => {
  const owner = new AbortController();
  const write = new ProgramClipboardWrite("text", owner.signal);
  owner.abort();
  expect(write.policyMessage({ code: "image-limit", message: "too large" })).toBeNull();
  write.dispose();
});

it("cancels an uncommitted native image write when its terminal closes", async () => {
  const { LatestClipboardWrite } = await import("./LatestClipboardWrite");
  const { TerminalRequestLifetime } = await import("./TerminalRequestLifetime");
  const lifetime = new TerminalRequestLifetime();
  let release!: () => void;
  let committed = false;
  ipc.invoke.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    if (!order.latest) throw new Error("cancelled");
    committed = true;
  });
  let completed!: () => void;
  const done = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const queue = new LatestClipboardWrite<
    Parameters<typeof writeTerminalClipboardContent>[0]
  >(async (value) => {
    try {
      await writeTerminalClipboardContent(value, lifetime.programSignal);
    } finally {
      completed();
    }
  });
  queue.enqueue({ mime: "image/jpeg", data: Uint8Array.of(1) });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  lifetime.dispose();
  await vi.waitFor(() => expect(order.latest).toBe(""));
  release();
  await done;
  expect(committed).toBe(false);
});

it("does not let an older program image replace a newer explicit Copy", async () => {
  let release!: () => void;
  const commits: string[] = [];
  native.writeText.mockImplementation(async (text) => {
    commits.push(text);
  });
  ipc.invoke.mockImplementation(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    if (!order.latest) throw new Error("superseded");
    commits.push("old program image");
  });
  const older = writeTerminalClipboardContent({
    mime: "image/jpeg",
    data: Uint8Array.of(1),
  });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await writeTerminalClipboard("new user selection");
  release();
  await expect(older).rejects.toThrow("superseded");
  expect(commits[commits.length - 1]).toBe("new user selection");
});

it("retains text fallback for a PNG rejected by native decoding", async () => {
  ipc.invoke.mockRejectedValue({
    code: "image-decode",
    message: "not a usable PNG",
  });
  await writeTerminalClipboardContent({
    mime: "image/png",
    data: Uint8Array.of(1),
    text: "alternative",
  });
  expect(native.writeText).toHaveBeenCalledWith("alternative");
});

it("propagates a structured native commit failure without writing alternative text", async () => {
  const error = { code: "clipboard-write", message: "clipboard busy" };
  ipc.invoke.mockRejectedValue(error);
  await expect(
    writeTerminalClipboardContent({
      mime: "image/png",
      data: Uint8Array.of(1),
      text: "alternative",
    }),
  ).rejects.toEqual(error);
  expect(native.writeText).not.toHaveBeenCalled();
});

it("invalidates a cached image when an Oarlock Copy button writes new text", async () => {
  const { writeClipboardText } = await import("@/lib/clipboardWrite");
  await writeTerminalClipboard("");
  ipc.invoke.mockResolvedValueOnce(Uint8Array.of(9).buffer);
  await expect(readClipboardImage()).resolves.toEqual(Uint8Array.of(9));
  await writeClipboardText("new Copy button selection");
  ipc.invoke.mockResolvedValueOnce(new ArrayBuffer(0));
  await expect(readClipboardImage()).resolves.toBeNull();
});

it("does not reuse an image after another window or application replaces the clipboard", async () => {
  await writeTerminalClipboard("");
  ipc.invoke.mockResolvedValueOnce(Uint8Array.of(7).buffer);
  await expect(readClipboardImage()).resolves.toEqual(Uint8Array.of(7));
  // Native now has a different clipboard, but this page received no local write.
  order.revision += 1;
  ipc.invoke.mockResolvedValueOnce(new ArrayBuffer(0));
  await expect(readClipboardImage()).resolves.toBeNull();
});
