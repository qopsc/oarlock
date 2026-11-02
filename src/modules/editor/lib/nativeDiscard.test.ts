import { afterEach, expect, it, vi } from "vitest";
import { DocumentSession, type DocumentIo } from "./documentSession";
import {
  prepareNativeDiscard,
  registerDiscardDocument,
  type DiscardMatch,
} from "./gitSignals";

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: core.invoke }));

/** Preparation with its identity lookup bound, as the bridge binds it. */
function prepare(
  workspace: { kind: "local" },
  preserve: boolean,
  match: DiscardMatch,
) {
  const round = prepareNativeDiscard(workspace, preserve);
  return {
    ready: () => round.ready(match),
    complete: round.complete,
    dispose: round.dispose,
  };
}
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
  const preparation = prepare(workspace, true, async (paths) =>
    paths.map((file) => fs.realpathSync(file) === target),
  );
  cleanups.push(preparation.dispose);
  session.change("new work in another window");
  await session.save();
  await preparation.ready();
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
  const preparation = prepare(workspace, true, async () => [
    false,
  ]);
  cleanups.push(preparation.dispose);
  await preparation.ready();
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
  const preparation = prepare(workspace, true, matcher);
  cleanups.push(preparation.dispose);
  let ready = false;
  const waiting = preparation.ready().then(() => {
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
  const preparation = prepare(workspace, false, async () => {
    throw new Error("lookup unavailable");
  });
  cleanups.push(preparation.dispose);
  session.change("new work");
  await session.save();
  await expect(preparation.ready()).rejects.toThrow(
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
  const preparation = prepare(
    workspace,
    true,
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const waiting = preparation.ready();
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
const entries = [{ path: "file", untracked: false }];
function native(overrides: Record<string, (args: never) => unknown> = {}) {
  core.invoke.mockReset();
  core.invoke.mockImplementation(async (command: string, args: never) => {
    const handler = overrides[command];
    if (handler) return handler(args);
    if (command === "git_discard_scope") return ["/real/repo/file"];
    if (command === "git_discard_match")
      return (args as { paths: string[] }).paths.map(() => true);
    return undefined;
  });
}
it("the bridge sends raw document paths with the native roots and compares no spelling", async () => {
  const { discardAcrossWindows } = await import("./discardBridge");
  const disk = memory();
  document("/alias/repo/./file", disk.io);
  await flush();
  native();
  await discardAcrossWindows("/alias/repo", entries, workspace);
  expect(core.invoke).toHaveBeenCalledWith("git_discard_match", {
    roots: ["/real/repo/file"],
    paths: ["/alias/repo/./file"],
    workspace,
  });
  expect(core.invoke).toHaveBeenCalledWith("git_discard", {
    repoRoot: "/alias/repo",
    entries,
    roots: ["/real/repo/file"],
    workspace,
  });
});
it("Git waits for native identity resolution before dispatch", async () => {
  const { discardAcrossWindows } = await import("./discardBridge");
  document("/alias", memory().io);
  await flush();
  let answer!: (matches: boolean[]) => void;
  native({
    git_discard_match: () =>
      new Promise<boolean[]>((resolve) => {
        answer = resolve;
      }),
  });
  const running = discardAcrossWindows("/repo", entries, workspace);
  await flush();
  expect(core.invoke.mock.calls.some(([c]) => c === "git_discard")).toBe(false);
  answer([true]);
  await running;
  expect(core.invoke.mock.calls.some(([c]) => c === "git_discard")).toBe(true);
});
it("the originating window replaces only unchanged buffers", async () => {
  const { discardAcrossWindows } = await import("./discardBridge");
  const a = memory(),
    b = memory(),
    c = memory();
  const unchanged = document("/repo/a", a.io);
  const typed = document("/repo/b", b.io);
  const unmatched = document("/elsewhere/c", c.io);
  await flush();
  native({
    git_discard_match: (args) =>
      (args as unknown as { paths: string[] }).paths.map((p) =>
        p.startsWith("/repo/"),
      ),
    git_discard: () => {
      a.set("HEAD");
      b.set("HEAD");
      c.set("HEAD");
    },
  });
  const running = discardAcrossWindows("/repo", entries, workspace);
  typed.change("typed after confirmation");
  await running;
  await flush();
  expect(unchanged.text()).toBe("HEAD");
  expect(typed.text()).toBe("typed after confirmation");
  expect(typed.hasUnsavedChanges()).toBe(true);
  expect(unmatched.text()).toBe("working tree");
});
it("a failed Discard keeps every buffer", async () => {
  const { discardAcrossWindows } = await import("./discardBridge");
  const disk = memory();
  const session = document("/repo/a", disk.io);
  await flush();
  native({
    git_discard: () => {
      disk.set("HEAD");
      throw new Error("git failed");
    },
  });
  await expect(
    discardAcrossWindows("/repo", entries, workspace),
  ).rejects.toThrow("git failed");
  await flush();
  expect(session.text()).toBe("working tree");
});
it("cancellation before lookup dispatch avoids native work", async () => {
  const disk = memory();
  document("/alias", disk.io);
  await flush();
  const match = vi.fn(async () => [true]);
  const preparation = prepare(workspace, true, match);
  const waiting = preparation.ready();
  preparation.dispose();
  await waiting;
  expect(match).not.toHaveBeenCalled();
});
it("malformed matches and undefined failures cannot acknowledge readiness", async () => {
  for (const answer of [[], [undefined], null]) {
    const disk = memory();
    const session = document("/alias", disk.io);
    await flush();
    const preparation = prepare(workspace, true, async () => {
      if (answer === null) throw undefined;
      return answer as unknown as boolean[];
    });
    session.change("kept");
    await session.save();
    await expect(preparation.ready()).rejects.toBeDefined();
    disk.set("HEAD");
    preparation.dispose();
    await flush();
    expect(session.text()).toBe("kept");
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  }
});
