import { beforeEach, describe, expect, it, vi } from "vitest";
const clipboard = vi.hoisted(() => ({
  readPrimarySelection: vi.fn(async () => "primary"),
  readTerminalClipboard: vi.fn(async () => "clipboard"),
  readClipboardImage: vi.fn(),
}));
vi.mock("../lib/terminalClipboard", () => ({
  ...clipboard,
  readTerminalClipboardSnapshot: async (image: string, primary: boolean) => ({
    revision: "1",
    text: await (primary
      ? clipboard.readPrimarySelection()
      : clipboard.readTerminalClipboard()),
    image: image === "always" ? await clipboard.readClipboardImage() : null,
  }),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({ terminalBehavior: { clipboardRead: "allow" } }),
  },
}));
import {
  clipboardReadReply,
  terminalIntegrationCallbacks,
} from "./terminalIntegration";

import { TerminalRequestLifetime } from "../lib/TerminalRequestLifetime";
let requests: TerminalRequestLifetime;
beforeEach(() => {
  requests = new TerminalRequestLifetime();
});

describe("OSC52 selection reads", () => {
  it.each([
    ["p", "primary"],
    ["c", "clipboard"],
    ["s", "clipboard"],
    ["q", ""],
  ])("reads selection %s from its own source", async (selection, text) => {
    const reply = vi.fn();
    const callbacks = terminalIntegrationCallbacks({
      leafId: 1,
      clipboardSignal: () => requests.clipboardSignal,
      reply,
      userIsLooking: () => true,
      answerKittyClipboardRead: vi.fn(),
      pointerTarget: () => null,
    });
    callbacks.onClipboardRead?.(selection, "st");
    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
    expect(new TextDecoder().decode(reply.mock.calls[0][0])).toBe(
      clipboardReadReply(selection, text, "st"),
    );
  });
});

it("does not deliver an old OSC52 clipboard read to a restarted terminal", async () => {
  const { BoundedPtyWriter } = await import("../lib/BoundedPtyWriter");
  const writer = new BoundedPtyWriter(() => {});
  const oldWrite = vi.fn(async () => {});
  const newWrite = vi.fn(async () => {});
  writer.attach({
    id: 1,
    write: oldWrite,
    resize: async () => {},
    close: async () => {},
  });
  let finish!: (text: string) => void;
  clipboard.readTerminalClipboard.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const callbacks = terminalIntegrationCallbacks({
    leafId: 1,
    clipboardSignal: () => requests.clipboardSignal,
    userIsLooking: () => true,
    pointerTarget: () => null,
    reply: (bytes) => {
      writer.enqueue(bytes, true);
    },
    answerKittyClipboardRead: vi.fn(),
  });
  callbacks.onClipboardRead?.("c", "st");
  // The session restart path detaches/clears, then reuses this writer.
  requests.dispose();
  writer.detach();
  writer.clear();
  writer.attach({
    id: 2,
    write: newWrite,
    resize: async () => {},
    close: async () => {},
  });
  finish("private clipboard");
  await Promise.resolve();
  await Promise.resolve();
  writer.dispose();
  expect(newWrite).not.toHaveBeenCalled();
});

it.each(["osc52", "kitty"])(
  "revokes an in-flight %s read on permission change",
  async (protocol) => {
    let finish!: (text: string) => void;
    clipboard.readTerminalClipboard.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const reply = vi.fn();
    const kittyReply = vi.fn();
    const callbacks = terminalIntegrationCallbacks({
      leafId: 1,
      clipboardSignal: () => requests.clipboardSignal,
      userIsLooking: () => true,
      pointerTarget: () => null,
      reply,
      answerKittyClipboardRead: kittyReply,
    });
    if (protocol === "osc52") callbacks.onClipboardRead?.("c", "st");
    else
      callbacks.onKittyClipboardRead?.({
        type: "kitty-clipboard-read",
        id: 7,
        name: "vim",
        primary: false,
        mimes: ["text/plain"],
        list: false,
        granted: false,
      });
    requests.cancelReads();
    finish("private clipboard");
    await Promise.resolve();
    await Promise.resolve();
    if (protocol === "osc52") {
      expect(reply).toHaveBeenCalledOnce();
      expect(new TextDecoder().decode(reply.mock.calls[0][0])).toBe(
        clipboardReadReply("c", "", "st"),
      );
    } else expect(kittyReply.mock.calls).toEqual([[7, { status: "denied" }]]);
    // The replacement permission generation may serve fresh requests.
    callbacks.onClipboardRead?.("c", "st");
    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledTimes(protocol === "osc52" ? 2 : 1),
    );
  },
);
