import { expect, it, vi } from "vitest";
import { DocumentSession, type DocumentIo } from "./documentSession";

function fixture() {
  const io: DocumentIo = {
    read: async () => ({
      kind: "text",
      content: "old",
      size: 3,
      mtime: 0,
      version: "old",
    }),
    write: async () => ({ kind: "saved", version: "new" }),
  };
  const host = {
    state: vi.fn(),
    dirty: vi.fn(),
    saved: vi.fn(),
    saveFailed: vi.fn(),
    conflict: vi.fn(),
    released: vi.fn(),
    autoSave: () => ({ enabled: false, delay: 0 }),
  };
  return new DocumentSession(io, host);
}

it.each([
  "edit",
  "close",
  "detach",
  "reload",
  "save",
  "discard",
  "baseline",
] as const)(
  "cancels an obsolete formatter on %s and retains the buffer",
  async (reason) => {
    const session = fixture();
    session.open("/a");
    await vi.waitFor(() => expect(session.text()).toBe("old"));
    session.change("draft");
    let signal!: AbortSignal;
    let finish!: () => void;
    const format = session.formatAndSave((_path, _content, owner) => {
      signal = owner;
      return new Promise((resolve) => {
        finish = () => resolve({ content: "formatted", size: 9 });
      });
    });
    if (reason === "edit") session.change("new draft");
    else if (reason === "close") session.close();
    else if (reason === "detach") session.detach();
    else if (reason === "reload") session.openAnyway();
    else if (reason === "save") await session.save();
    else if (reason === "discard") session.prepareDiscard();
    else session.adoptDiskText("other", "other");
    expect(signal.aborted).toBe(true);
    finish();
    expect(await format).toBe(false);
    if (reason === "edit") expect(session.text()).toBe("new draft");
  },
);
