import { afterEach, expect, it, vi } from "vitest";
import { DocumentSession, type DocumentIo } from "./documentSession";
import { prepareNativeDiscard, registerDiscardDocument } from "./gitSignals";
import { DiscardCoordinator } from "./discardCoordinator";
const cleanups: (() => void)[] = [];
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const workspace = { kind: "local" } as const;
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function document(path: string, io: DocumentIo) {
  const host = {
    state: vi.fn(),
    dirty: vi.fn(),
    saved: vi.fn(),
    saveFailed: vi.fn(),
    conflict: vi.fn(),
    released: vi.fn(),
    autoSave: () => ({ enabled: false, delay: 100 }),
  };
  const session = new DocumentSession(io, host);
  session.open(path);
  cleanups.push(() => session.close());
  cleanups.push(
    registerDiscardDocument({
      path,
      workspace,
      prepare: session.prepareDiscard,
      stage: session.stageDiscard,
    }),
  );
  return session;
}
function memory() {
  let disk = "working tree";
  return {
    get: () => disk,
    set: (text: string) => {
      disk = text;
    },
    io: {
      read: async () => ({
        kind: "text" as const,
        content: disk,
        size: disk.length,
        mtime: 1,
        version: disk,
      }),
      write: async (_path: string, text: string) => {
        disk = text;
        return { kind: "saved" as const, version: text };
      },
    },
  };
}
it("the real-filesystem directory-alias reproduction retains newer autosaved text", async () => {
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "oarlock-discard-alias-")),
  );
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"),
    alias = path.join(root, "alias");
  fs.mkdirSync(repo);
  fs.symlinkSync(
    repo,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const target = path.join(repo, "file");
  fs.writeFileSync(target, "working tree");
  const session = document(path.join(alias, "./file"), {
    read: async (file) => {
      const content = fs.readFileSync(file, "utf8");
      return {
        kind: "text",
        content,
        size: content.length,
        mtime: 1,
        version: content,
      };
    },
    write: async (file, content) => {
      fs.writeFileSync(file, content);
      return { kind: "saved", version: content };
    },
  });
  await flush();
  // This models the native response; real Rust tests cover resolution, gates,
  // leaf symlinks and missing entries through match_documents itself.
  const preparation = prepareNativeDiscard(
    workspace,
    true,
    async (_id, _token, paths) =>
      paths.map((file) => fs.realpathSync(file) === target),
  );
  cleanups.push(preparation.dispose);
  session.change("new work in another window");
  await session.save();
  await preparation.ready("1", "page");
  fs.writeFileSync(target, "HEAD");
  preparation.complete();
  session.reload();
  await flush();
  expect(session.text()).toBe("new work in another window");
  expect(session.hasUnsavedChanges()).toBe(true);
});
it("unrelated identities do not become dirty or trigger disk reads", async () => {
  const disk = memory();
  const read = vi.fn(disk.io.read);
  const session = document("/unrelated", { ...disk.io, read });
  await flush();
  const preparation = prepareNativeDiscard(workspace, true, async () => [
    false,
  ]);
  cleanups.push(preparation.dispose);
  await preparation.ready("1", "page");
  preparation.complete();
  await flush();
  expect(session.isSaved()).toBe(true);
  expect(read).toHaveBeenCalledOnce();
});
it("documents mounted during identity resolution join the readiness barrier", async () => {
  const disk = memory();
  document("/first", disk.io);
  await flush();
  const answers: ((matches: boolean[]) => void)[] = [];
  const matcher = vi.fn(
    () => new Promise<boolean[]>((resolve) => answers.push(resolve)),
  );
  const preparation = prepareNativeDiscard(workspace, true, matcher);
  cleanups.push(preparation.dispose);
  let ready = false;
  const waiting = preparation.ready("1", "page").then(() => {
    ready = true;
  });
  const late = document("/late-alias", disk.io);
  await flush();
  late.change("new late draft");
  await late.save();
  answers[0]([false]);
  await flush();
  expect(ready).toBe(false);
  answers[1]([true]);
  await waiting;
  disk.set("HEAD");
  preparation.complete();
  await flush();
  expect(late.text()).toBe("new late draft");
  expect(late.hasUnsavedChanges()).toBe(true);
});
it("identity failure refuses preparation and preserves unknown buffers", async () => {
  const disk = memory();
  const session = document("/alias", disk.io);
  await flush();
  const preparation = prepareNativeDiscard(workspace, false, async () => {
    throw new Error("lookup unavailable");
  });
  cleanups.push(preparation.dispose);
  session.change("new work");
  await session.save();
  await expect(preparation.ready("1", "page")).rejects.toThrow(
    "lookup unavailable",
  );
  disk.set("HEAD");
  preparation.dispose();
  await flush();
  expect(session.text()).toBe("new work");
  expect(session.hasUnsavedChanges()).toBe(true);
});
it("disposal during lookup cannot reattach protection or alter later navigation", async () => {
  const disk = memory();
  const session = document("/alias", disk.io);
  await flush();
  let answer!: (matches: boolean[]) => void;
  const preparation = prepareNativeDiscard(
    workspace,
    true,
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const waiting = preparation.ready("1", "page");
  await flush();
  preparation.dispose();
  await flush();
  session.open("/other");
  await flush();
  session.change("replacement draft");
  answer([true]);
  await waiting;
  expect(session.text()).toBe("replacement draft");
});
it("Git waits for native identity resolution before dispatch", async () => {
  const disk = memory();
  document("/alias", disk.io);
  await flush();
  let answer!: (matches: boolean[]) => void;
  const invoke = vi.fn(async (command: string) =>
    command === "git_discard_begin" ? "1" : undefined,
  );
  const coordinator = new DiscardCoordinator({
    invoke: invoke as never,
    problem: vi.fn(),
    prepare: () =>
      prepareNativeDiscard(
        workspace,
        false,
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      ),
  });
  cleanups.push(() => coordinator.dispose());
  coordinator.ready("page");
  const running = coordinator.execute({
    repoRoot: "/repo",
    entries: [{ path: "file", untracked: false }],
    workspace,
  });
  await flush();
  expect(invoke.mock.calls.some(([cmd]) => cmd === "git_discard")).toBe(false);
  answer([true]);
  await running;
  await flush();
  expect(invoke.mock.calls.some(([cmd]) => cmd === "git_discard")).toBe(true);
});
it("completion cannot acknowledge native settlement before a late identity lookup", async () => {
  const disk = memory();
  const session = document("/alias", disk.io);
  await flush();
  let answer!: (matches: boolean[]) => void;
  const invoke = vi.fn(async () => undefined);
  const coordinator = new DiscardCoordinator({
    invoke: invoke as never,
    problem: vi.fn(),
    prepare: () =>
      prepareNativeDiscard(
        workspace,
        true,
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      ),
  });
  cleanups.push(() => coordinator.dispose());
  coordinator.ready("page");
  const event = {
    id: "1",
    token: "page",
    nonce: "n",
    owner: false,
    paths: ["/repo/file"],
    workspace,
    phase: "complete" as const,
  };
  coordinator.receive(event);
  await flush();
  expect(invoke).not.toHaveBeenCalled();
  session.change("late work");
  await session.save();
  disk.set("HEAD");
  answer([true]);
  await flush();
  expect(session.text()).toBe("late work");
  expect(invoke).toHaveBeenCalledWith("git_discard_settled", {
    token: "page",
    id: "1",
  });
});

it("cancellation before lookup dispatch avoids native work", async () => {
  const disk = memory();
  document("/alias", disk.io);
  await flush();
  const match = vi.fn(async () => [true]);
  const preparation = prepareNativeDiscard(workspace, true, match);
  const waiting = preparation.ready("1", "page");
  preparation.dispose();
  await waiting;
  expect(match).not.toHaveBeenCalled();
});
it("malformed matches and undefined failures cannot acknowledge readiness", async () => {
  for (const answer of [[], [undefined], null]) {
    const disk = memory();
    const session = document("/alias", disk.io);
    await flush();
    const preparation = prepareNativeDiscard(workspace, true, async () => {
      if (answer === null) throw undefined;
      return answer as unknown as boolean[];
    });
    session.change("kept");
    await session.save();
    await expect(preparation.ready("1", "page")).rejects.toBeDefined();
    disk.set("HEAD");
    preparation.dispose();
    await flush();
    expect(session.text()).toBe("kept");
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  }
});
