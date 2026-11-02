import { afterEach, expect, it, vi } from "vitest";
import { DocumentSession, type DocumentIo } from "./documentSession";
import {
  subscribeDocumentMutations,
  type DocumentMutation,
} from "./documentMutations";
import { registerDiscardDocument } from "./gitSignals";
import { mutationFenceDown } from "./mutationFence";
import { observeRecoveryTarget } from "./recoveryTarget";
import { createRemoteDiscards } from "./remoteDiscard";

const cleanups: (() => void)[] = [];
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const workspace = { kind: "local" } as const;
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  mutationFenceDown();
});

/** Window B: a document over a shared disk whose reads report a stream sequence. */
function windowB(path = "/repo/file") {
  let disk = "working tree";
  let sequence = 5;
  const io: DocumentIo = {
    read: async () => ({
      kind: "text",
      content: disk,
      size: disk.length,
      mtime: 1,
      version: disk,
      mutationSequence: sequence,
    }),
    write: async (_path, text) => {
      disk = text;
      return { kind: "saved", version: text };
    },
  };
  const session = new DocumentSession(io, {
    state: vi.fn(),
    dirty: vi.fn(),
    saved: vi.fn(),
    saveFailed: vi.fn(),
    conflict: vi.fn(),
    released: vi.fn(),
    autoSave: () => ({ enabled: false, delay: 100 }),
  });
  session.open(path);
  cleanups.push(() => session.close());
  cleanups.push(
    registerDiscardDocument({
      path,
      workspace,
      stage: session.stageDiscard,
    }),
  );
  return {
    session,
    setDisk: (text: string, seen = sequence) => {
      disk = text;
      sequence = seen;
    },
  };
}

async function listener(
  match: (roots: string[], paths: string[]) => Promise<boolean[]> = async (
    _roots,
    paths,
  ) => paths.map(() => true),
  startAt = 5,
) {
  let receive!: (event: DocumentMutation) => void;
  const apply = vi.fn();
  const stop = subscribeDocumentMutations(
    async (next) => {
      receive = next;
      return () => {};
    },
    apply,
    vi.fn(),
    undefined,
    undefined,
    {
      ...createRemoteDiscards("main", (roots, paths) => match(roots, paths)),
      currentSequence: async () => startAt,
    },
  );
  cleanups.push(stop);
  await flush();
  return { receive, apply, stop };
}
const begin = (sequence: number, roots = ["/repo/file"]): DocumentMutation => ({
  sequence,
  workspace,
  kind: "discard-begin",
  id: sequence,
  origin: "w-a",
  repoRoot: "/repo",
  roots,
});
const end = (sequence: number, id: number, ok = true): DocumentMutation => ({
  sequence,
  workspace,
  kind: "discard-end",
  id,
  ok,
});

it("a read observing a newer mutation sequence is not adopted before the begin event", async () => {
  const b = windowB();
  await flush();
  const { receive } = await listener();
  b.session.change("T");
  await b.session.save();
  expect(b.session.hasUnsavedChanges()).toBe(false);
  // Git has rewritten the file; the watcher's read returns HEAD stamped with the
  // begin event's sequence before this window has handled that event.
  b.setDisk("HEAD", 6);
  b.session.reload();
  await flush();
  receive(begin(6));
  await flush();
  expect(b.session.text()).toBe("T");
  receive(end(7, 6));
  await flush();
  expect(b.session.text()).toBe("T");
  expect(b.session.hasUnsavedChanges()).toBe(true);
});

it("a window that autosaved newer text keeps it when Git rewrites the file", async () => {
  const b = windowB();
  await flush();
  const { receive } = await listener();
  receive(begin(6));
  await flush();
  b.session.change("T");
  await b.session.save();
  b.setDisk("HEAD", 6);
  b.session.reload();
  await flush();
  expect(b.session.text()).toBe("T");
  receive(end(7, 6));
  await flush();
  expect(b.session.text()).toBe("T");
  expect(b.session.hasUnsavedChanges()).toBe(true);
});

it("a dirty buffer in another window is never adopted", async () => {
  const b = windowB();
  await flush();
  const { receive } = await listener();
  receive(begin(6));
  b.session.change("unsaved");
  b.setDisk("HEAD", 6);
  b.session.reload();
  receive(end(7, 6));
  await flush();
  expect(b.session.text()).toBe("unsaved");
});

it("a gap in the stream releases a round and keeps the text", async () => {
  const b = windowB();
  await flush();
  const { receive } = await listener();
  receive(begin(6));
  await flush();
  b.session.change("T");
  await b.session.save();
  b.setDisk("HEAD", 6);
  receive({ sequence: 9, workspace, kind: "deleted", paths: ["/other"] });
  await flush();
  expect(b.session.text()).toBe("T");
});

it("this window's own discard is left to its bridge", async () => {
  const b = windowB();
  await flush();
  const stage = vi.spyOn(b.session, "stageDiscard");
  const { receive } = await listener();
  receive({ ...(begin(6) as object), origin: "main" } as DocumentMutation);
  await flush();
  expect(stage).not.toHaveBeenCalled();
});

it("a rejected identity lookup keeps the round, so Git's later write is not adopted", async () => {
  const b = windowB();
  await flush();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { receive } = await listener(async () => {
    throw new Error("ipc down");
  });
  b.session.change("T");
  await b.session.save();
  receive(begin(6));
  await flush();
  // Git writes after the lookup failed and before discard-end.
  b.setDisk("HEAD", 6);
  b.session.reload();
  await flush();
  expect(b.session.text()).toBe("T");
  receive(end(7, 6));
  await flush();
  expect(b.session.text()).toBe("T");
  expect(b.session.hasUnsavedChanges()).toBe(true);
});

it("discard events never reach tab planning and begin invalidates a pending recovery under its roots", async () => {
  const { receive, apply } = await listener();
  const inside = observeRecoveryTarget("/repo/dir/draft", "local");
  const outside = observeRecoveryTarget("/elsewhere/draft", "local");
  cleanups.push(inside.dispose, outside.dispose);
  receive(begin(6, ["/repo/dir"]));
  receive(end(7, 6));
  await flush();
  expect(apply).not.toHaveBeenCalled();
  expect(inside.changed()).toBe(true);
  expect(outside.changed()).toBe(false);
});
