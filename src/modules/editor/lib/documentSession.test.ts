import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DocumentIo,
  DocumentSession,
  type DocumentState,
  type ReadResult,
} from "./documentSession";
import { consumeRetarget, noteRetarget } from "./pathRetarget";

type Op = "read" | "write";

function createDisk(files: Record<string, string>) {
  let clock = 100;
  const disk = new Map<string, { content: string; mtime: number }>();
  for (const [path, content] of Object.entries(files)) {
    disk.set(path, { content, mtime: ++clock });
  }
  const log: string[] = [];
  const held = new Map<Op, Array<() => void>>();
  const holds = new Set<Op>();
  const failures = new Map<string, string>();
  const gate = async (op: Op) => {
    if (!holds.has(op)) return;
    await new Promise<void>((resolve) => {
      const queue = held.get(op) ?? [];
      queue.push(resolve);
      held.set(op, queue);
    });
  };
  const io: DocumentIo = {
    read: async (path, force) => {
      log.push(`read ${path}${force ? " force" : ""}`);
      await gate("read");
      const file = disk.get(path);
      if (!file) throw new Error(`ENOENT ${path}`);
      return {
        kind: "text",
        content: file.content,
        size: file.content.length,
        mtime: file.mtime,
        version: file.content,
      };
    },
    write: async (path, text, expected) => {
      await gate("write");
      const current = disk.get(path)?.content ?? null;
      if (current !== expected) return { kind: "conflict", version: current };
      log.push(`write ${path}`);
      const failure = failures.get(path);
      if (failure) throw new Error(failure);
      disk.set(path, { content: text, mtime: ++clock });
      return { kind: "saved", version: text };
    },
  };
  return {
    disk,
    io,
    log,
    failures,
    /** Later calls of `op` wait until `release(op)`. */
    hold: (op: Op) => holds.add(op),
    release: (op: Op) => {
      holds.delete(op);
      for (const resolve of held.get(op) ?? []) resolve();
      held.delete(op);
    },
    /** Another program writes the file (or only bumps its mtime). */
    touch: (path: string, content?: string) => {
      const file = disk.get(path);
      disk.set(path, {
        content: content ?? file?.content ?? "",
        mtime: ++clock,
      });
    },
    rename: (from: string, to: string) => {
      const file = disk.get(from);
      if (!file) throw new Error(`ENOENT ${from}`);
      disk.delete(from);
      disk.set(to, file);
    },
  };
}

function setup(
  files: Record<string, string>,
  autoSave = { enabled: false, delay: 500 },
) {
  const fs = createDisk(files);
  const host = {
    state: vi.fn<(doc: DocumentState) => void>(),
    dirty: vi.fn<(dirty: boolean) => void>(),
    saved: vi.fn<(path: string) => void>(),
    saveFailed: vi.fn<(path: string, error: unknown) => void>(),
    conflict: vi.fn<(path: string, overwrite: () => void) => void>(),
    released: vi.fn<(path: string) => void>(),
    autoSave: () => autoSave,
  };
  const session = new DocumentSession(fs.io, host);
  return {
    ...fs,
    host,
    session,
    doc: () => host.state.mock.lastCall?.[0],
    dirty: () => host.dirty.mock.lastCall?.[0] ?? false,
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function pendingRead(t: ReturnType<typeof setup>) {
  let finish!: (value: ReadResult) => void;
  t.io.read = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  return (content: string, allowed: boolean) =>
    finish({
      kind: "text",
      content,
      size: content.length,
      mtime: 200,
      aiContextAllowed: allowed,
    });
}

it("keeps the latest reload and its AI eligibility when reads settle out of order", async () => {
  const t = setup({ "/p/a.ts": "initial" });
  t.session.open("/p/a.ts");
  await flush();
  const old = pendingRead(t);
  t.session.reload();
  const current = pendingRead(t);
  t.session.reload();
  current("latest", false);
  await flush();
  old("outdated", true);
  await flush();
  expect(t.session.text()).toBe("latest");
  expect(t.session.canComplete("/p/a.ts")).toBe(false);
});

it("does not let a pre-save reload restore old text after newer edits are saved", async () => {
  const t = setup({ "/p/a.ts": "initial" });
  t.session.open("/p/a.ts");
  await flush();
  const finish = pendingRead(t);
  t.session.reload();
  t.session.change("saved edits");
  expect(await t.session.save()).toBe(true);
  finish("initial", true);
  await flush();
  expect(t.session.text()).toBe("saved edits");
  expect(t.disk.get("/p/a.ts")?.content).toBe("saved edits");
  expect(t.dirty()).toBe(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DocumentSession loading", () => {
  it("publishes the file as ready and clean", async () => {
    const t = setup({ "/p/a.ts": "one\r\ntwo\r\n" });
    t.session.open("/p/a.ts");
    expect(t.doc()).toEqual({ status: "loading" });
    await flush();
    expect(t.doc()).toEqual({
      status: "ready",
      content: "one\ntwo\n",
      size: 10,
    });
    expect(t.dirty()).toBe(false);
  });

  it("restores the file's line endings on save", async () => {
    const t = setup({ "/p/a.ts": "one\r\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("one\nmore\n");
    expect(await t.session.save()).toBe(true);
    expect(t.disk.get("/p/a.ts")?.content).toBe("one\r\nmore\r\n");
    expect(t.dirty()).toBe(false);
    expect(t.host.saved).toHaveBeenCalledWith("/p/a.ts");
  });

  it("drops a load that resolves after the pane closed", async () => {
    const t = setup({ "/p/a.ts": "one\n" });
    t.hold("read");
    t.session.open("/p/a.ts");
    t.session.close();
    t.release("read");
    await flush();
    expect(t.doc()).toEqual({ status: "loading" });
    expect(t.host.released).toHaveBeenCalledWith("/p/a.ts");
  });

  it("keeps the dirty flag current for a reload before the next render", async () => {
    const t = setup({ "/p/a.ts": "one\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("typed\n");
    expect(t.session.reload()).toBe(false);
  });
});

describe("DocumentSession rename (crynta/terax-ai#1369)", () => {
  it("keeps unsaved edits when the open file is renamed", async () => {
    const t = setup({ "/p/a.ts": "saved\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("unsaved\n");

    t.rename("/p/a.ts", "/p/b.ts");
    noteRetarget("/p/a.ts", "/p/b.ts");
    t.session.open("/p/b.ts");
    await flush();

    expect(t.log.filter((l) => l.startsWith("read"))).toEqual(["read /p/a.ts"]);
    expect(t.doc()).toEqual({ status: "ready", content: "saved\n", size: 6 });
    expect(t.dirty()).toBe(true);
    expect(t.host.released).toHaveBeenCalledWith("/p/a.ts");

    expect(await t.session.save()).toBe(true);
    expect(t.disk.get("/p/b.ts")?.content).toBe("unsaved\n");
    expect(t.disk.has("/p/a.ts")).toBe(false);
    expect(t.host.conflict).not.toHaveBeenCalled();
  });

  it("loads from disk on a path change that is not a rename", async () => {
    const t = setup({ "/p/a.ts": "a\n", "/p/b.ts": "b\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("edit\n");
    t.session.open("/p/b.ts");
    expect(t.dirty()).toBe(false);
    await flush();
    expect(t.doc()).toEqual({ status: "ready", content: "b\n", size: 2 });
    expect(await t.session.save()).toBe(true);
    expect(t.log).not.toContain("write /p/b.ts");
  });

  it("reads the new path when renamed mid-load and leaves no note behind", async () => {
    const t = setup({ "/p/a.ts": "a\n" });
    t.hold("read");
    t.session.open("/p/a.ts");
    t.rename("/p/a.ts", "/p/b.ts");
    noteRetarget("/p/a.ts", "/p/b.ts");
    t.session.open("/p/b.ts");
    t.release("read");
    await flush();
    expect(t.doc()).toEqual({ status: "ready", content: "a\n", size: 2 });
    expect(consumeRetarget("/p/a.ts", "/p/b.ts")).toBe(false);
  });

  it("re-arms a pending autosave onto the new path", async () => {
    vi.useFakeTimers();
    const t = setup({ "/p/a.ts": "a\n" }, { enabled: true, delay: 500 });
    t.session.open("/p/a.ts");
    await vi.advanceTimersByTimeAsync(0);
    t.session.change("edit\n");
    await vi.advanceTimersByTimeAsync(300);
    t.rename("/p/a.ts", "/p/b.ts");
    noteRetarget("/p/a.ts", "/p/b.ts");
    t.session.open("/p/b.ts");
    await vi.advanceTimersByTimeAsync(600);
    expect(t.log.filter((l) => l.startsWith("write"))).toEqual([
      "write /p/b.ts",
    ]);
    expect(t.disk.get("/p/b.ts")?.content).toBe("edit\n");
    expect(t.dirty()).toBe(false);
  });

  it("never writes the old path from a save started before the rename", async () => {
    const t = setup({ "/p/a.ts": "a\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("edit\n");
    const saving = t.session.save();
    t.rename("/p/a.ts", "/p/b.ts");
    noteRetarget("/p/a.ts", "/p/b.ts");
    t.session.open("/p/b.ts");
    expect(await saving).toBe(false);
    expect(t.log.filter((l) => l.startsWith("write"))).toEqual([]);
    expect(t.dirty()).toBe(true);
  });

  it("keeps the buffer dirty when a write completes after the rename", async () => {
    const t = setup({ "/p/a.ts": "a\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("edit\n");
    t.hold("write");
    const saving = t.session.save();
    await flush();
    noteRetarget("/p/a.ts", "/p/b.ts");
    t.session.open("/p/b.ts");
    t.release("write");
    expect(await saving).toBe(false);
    expect(t.dirty()).toBe(true);
    expect(t.host.saved).not.toHaveBeenCalled();
  });

  it("ignores an Overwrite from a notice raised before the rename", async () => {
    const t = setup({ "/p/a.ts": "a\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("mine\n");
    t.touch("/p/a.ts", "theirs\n");
    expect(await t.session.save()).toBe(false);
    const overwrite = t.host.conflict.mock.lastCall?.[1];
    t.rename("/p/a.ts", "/p/b.ts");
    noteRetarget("/p/a.ts", "/p/b.ts");
    t.session.open("/p/b.ts");
    overwrite?.();
    await flush();
    expect(t.log.filter((l) => l.startsWith("write"))).toEqual([]);
  });
});

describe("DocumentSession save conflicts (crynta/terax-ai#1375)", () => {
  it("writes when only the mtime moved on disk", async () => {
    const t = setup({ "/p/.env": "A=1\n" });
    t.session.open("/p/.env");
    await flush();
    t.session.change("A=2\n");
    t.touch("/p/.env");
    expect(await t.session.save()).toBe(true);
    expect(t.host.conflict).not.toHaveBeenCalled();
    expect(t.disk.get("/p/.env")?.content).toBe("A=2\n");
  });

  it("refuses when the disk content changed, until the user overwrites", async () => {
    const t = setup({ "/p/a.ts": "one\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("mine\n");
    t.touch("/p/a.ts", "theirs\n");
    expect(await t.session.save()).toBe(false);
    expect(t.disk.get("/p/a.ts")?.content).toBe("theirs\n");
    expect(t.host.conflict).toHaveBeenCalledOnce();
    t.host.conflict.mock.lastCall?.[1]();
    await flush();
    expect(t.disk.get("/p/a.ts")?.content).toBe("mine\n");
    expect(t.dirty()).toBe(false);
    expect(t.host.saved).toHaveBeenCalledWith("/p/a.ts");
  });

  it("compares a file opened anyway without the size limit", async () => {
    const t = setup({ "/p/big.log": "x\n" });
    t.session.open("/p/big.log");
    await flush();
    t.session.openAnyway();
    await flush();
    t.session.change("y\n");
    t.touch("/p/big.log");
    expect(await t.session.save()).toBe(true);
    expect(t.log.some((entry) => entry.startsWith("stat"))).toBe(false);
    expect(t.log.filter((l) => l === "read /p/big.log force")).toHaveLength(1);
  });

  it("raises no notice for a check that resolves after a rename", async () => {
    const t = setup({ "/p/a.ts": "one\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("mine\n");
    t.touch("/p/a.ts", "theirs\n");
    t.hold("write");
    const saving = t.session.save();
    await flush();
    t.rename("/p/a.ts", "/p/b.ts");
    noteRetarget("/p/a.ts", "/p/b.ts");
    t.session.open("/p/b.ts");
    t.release("write");
    expect(await saving).toBe(false);
    expect(t.host.conflict).not.toHaveBeenCalled();
    expect(t.log.filter((l) => l.startsWith("write"))).toEqual([]);
  });

  it("reports a failed save and keeps the buffer dirty", async () => {
    const t = setup({ "/p/a.ts": "one\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.failures.set("/p/a.ts", "EROFS");
    t.session.change("two\n");
    expect(await t.session.save()).toBe(false);
    expect(t.host.saveFailed).toHaveBeenCalledWith(
      "/p/a.ts",
      new Error("EROFS"),
    );
    expect(t.dirty()).toBe(true);
    expect(t.host.saved).not.toHaveBeenCalled();
  });

  it("retains the draft when atomic replacement is unavailable", async () => {
    const t = setup({ "/p/a.ts": "old\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("unsaved draft\n");
    t.failures.set("/p/a.ts", "Atomic replacement failed for /p/a.ts: read-only filesystem");
    expect(await t.session.save()).toBe(false);
    expect(t.session.text()).toBe("unsaved draft\n");
    expect(t.dirty()).toBe(true);
    expect(t.host.saveFailed).toHaveBeenCalledWith(
      "/p/a.ts",
      new Error("Atomic replacement failed for /p/a.ts: read-only filesystem"),
    );
    expect(t.host.saved).not.toHaveBeenCalled();
  });

  it("reports a failed autosave", async () => {
    vi.useFakeTimers();
    const t = setup({ "/p/a.ts": "one\n" }, { enabled: true, delay: 500 });
    t.session.open("/p/a.ts");
    await vi.advanceTimersByTimeAsync(0);
    t.failures.set("/p/a.ts", "EACCES: permission denied");
    t.session.change("two\n");
    await vi.advanceTimersByTimeAsync(600);
    expect(t.host.saveFailed).toHaveBeenCalledOnce();
    expect(t.dirty()).toBe(true);
  });

  it("reports a failed Overwrite", async () => {
    const t = setup({ "/p/a.ts": "one\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("mine\n");
    t.touch("/p/a.ts", "theirs\n");
    await t.session.save();
    t.failures.set("/p/a.ts", "EACCES");
    t.host.conflict.mock.lastCall?.[1]();
    await flush();
    expect(t.host.saveFailed).toHaveBeenCalledOnce();
  });
});

describe("DocumentSession reload after git discard (crynta/terax-ai#988)", () => {
  it("skips a dirty buffer on a plain reload", async () => {
    const t = setup({ "/p/a.ts": "head\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("edit\n");
    t.touch("/p/a.ts", "other\n");
    expect(t.session.reload()).toBe(false);
    await flush();
    expect(t.session.text()).toBe("edit\n");
  });

  it("replaces discarded unsaved edits when forced", async () => {
    const t = setup({ "/p/a.ts": "head\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("saved edit\n");
    await t.session.save();
    t.session.change("saved edit\nunsaved\n");
    t.touch("/p/a.ts", "head\n");
    expect(t.session.reload({ force: true })).toBe(true);
    await flush();
    expect(t.session.text()).toBe("head\n");
    expect(t.doc()).toEqual({ status: "ready", content: "head\n", size: 5 });
    expect(t.dirty()).toBe(false);
    t.session.change("head\nnext\n");
    expect(await t.session.save()).toBe(true);
    expect(t.host.conflict).not.toHaveBeenCalled();
  });

  it("publishes the discarded state even when disk equals the saved text", async () => {
    const t = setup({ "/p/a.ts": "head\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("unsaved\n");
    const published = t.host.state.mock.calls.length;
    t.session.reload({ force: true });
    await flush();
    expect(t.host.state.mock.calls.length).toBe(published + 1);
    expect(t.session.text()).toBe("head\n");
    expect(t.dirty()).toBe(false);
  });

  it("cancels a pending autosave of the discarded edits", async () => {
    vi.useFakeTimers();
    const t = setup({ "/p/a.ts": "head\n" }, { enabled: true, delay: 500 });
    t.session.open("/p/a.ts");
    await vi.advanceTimersByTimeAsync(0);
    t.session.change("discarded\n");
    t.session.reload({ force: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.log.filter((l) => l.startsWith("write"))).toEqual([]);
    expect(t.disk.get("/p/a.ts")?.content).toBe("head\n");
  });

  it("keeps edits typed while the forced read is in flight", async () => {
    const t = setup({ "/p/a.ts": "head\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("discarded\n");
    t.hold("read");
    t.session.reload({ force: true });
    t.session.change("typed after discard\n");
    t.release("read");
    await flush();
    expect(t.session.text()).toBe("typed after discard\n");
    expect(t.dirty()).toBe(true);
    t.touch("/p/a.ts");
    expect(await t.session.save()).toBe(true);
    expect(t.host.conflict).not.toHaveBeenCalled();
  });

  it("keeps the buffer when the discarded file is gone", async () => {
    const t = setup({ "/p/new.ts": "untracked\n" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    t.session.open("/p/new.ts");
    await flush();
    t.disk.delete("/p/new.ts");
    t.session.reload({ force: true });
    await flush();
    expect(t.session.text()).toBe("untracked\n");
    expect(t.doc()).toEqual({
      status: "ready",
      content: "untracked\n",
      size: 10,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("DocumentSession reload of a reverted file", () => {
  it("publishes text that equals what was first loaded", async () => {
    const t = setup({ "/p/a.ts": "v0\n" });
    t.session.open("/p/a.ts");
    await flush();
    t.session.change("v1\n");
    await t.session.save();
    t.touch("/p/a.ts", "v0\n");
    const published = t.host.state.mock.calls.length;
    expect(t.session.reload()).toBe(true);
    await flush();
    expect(t.host.state.mock.calls.length).toBe(published + 1);
    expect(t.doc()).toEqual({ status: "ready", content: "v0\n", size: 3 });
    expect(t.session.text()).toBe("v0\n");
  });
});

it("retains native privacy eligibility through edits, retargeting, and partial baseline adoption", async () => {
  const t = setup({ "/alias.txt": "SYNTHETIC_SECRET", "/safe.txt": "safe" });
  const read = t.io.read;
  t.io.read = async (path, force) => ({
    ...(await read(path, force)),
    aiContextAllowed: path === "/safe.txt",
  });
  t.session.open("/alias.txt");
  await vi.waitFor(() => expect(t.host.state).toHaveBeenCalled());
  expect(t.session.canComplete("/alias.txt")).toBe(false);
  t.session.change("SYNTHETIC_SECRET plus edit");
  t.session.adoptDiskText("safe baseline", "safe-version", true);
  expect(t.session.canComplete("/alias.txt")).toBe(false);
  noteRetarget("/alias.txt", "/renamed.txt");
  t.session.open("/renamed.txt");
  expect(t.session.canComplete("/renamed.txt")).toBe(false);
  t.session.open("/safe.txt");
  expect(t.session.canComplete("/safe.txt")).toBe(false);
  await vi.waitFor(() => expect(t.session.canComplete("/safe.txt")).toBe(true));
  t.session.adoptDiskText(
    "protected formatter result",
    "protected-version",
    false,
  );
  expect(t.session.canComplete("/safe.txt")).toBe(false);
  t.session.close();
  expect(t.session.canComplete("/safe.txt")).toBe(false);
});

it("concurrent editors cannot silently overwrite each other", async () => {
  const t = setup({ "/p/a.ts": "baseline" });
  const other = new DocumentSession(t.io, t.host);
  t.session.open("/p/a.ts");
  other.open("/p/a.ts");
  await flush();
  t.session.change("first window edits");
  other.change("second window edits");
  t.hold("write");
  const first = t.session.save();
  const second = other.save();
  await flush();
  t.release("write");
  const results = await Promise.all([first, second]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(t.host.conflict).toHaveBeenCalled();
  t.session.close();
  other.close();
});

it("serializes saves from one pane and uses the returned version for the next save", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  t.session.change("first");
  t.hold("write");
  const first = t.session.save();
  await flush();
  t.session.change("latest");
  const second = t.session.save();
  t.release("write");
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(t.disk.get("/a")?.content).toBe("latest");
  expect(t.dirty()).toBe(false);
  expect(t.host.conflict).not.toHaveBeenCalled();
  t.session.close();
});

it("rechecks a delayed Overwrite instead of replacing a newer disk edit", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  t.session.change("mine");
  t.touch("/a", "external");
  expect(await t.session.save()).toBe(false);
  const overwrite = t.host.conflict.mock.lastCall?.[1];
  t.touch("/a", "newer external");
  overwrite?.();
  await flush();
  expect(t.disk.get("/a")?.content).toBe("newer external");
  expect(t.host.conflict).toHaveBeenCalledTimes(2);
  expect(t.dirty()).toBe(true);
  t.session.close();
});

it("requires explicit Overwrite before recreating a deleted document", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  t.session.change("mine");
  t.disk.delete("/a");
  expect(await t.session.save()).toBe(false);
  expect(t.disk.has("/a")).toBe(false);
  t.host.conflict.mock.lastCall?.[1]();
  await flush();
  expect(t.disk.get("/a")?.content).toBe("mine");
  t.session.close();
});

it("does not skip a queued save when edits return to the old baseline", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  t.hold("write");
  t.session.change("first");
  const first = t.session.save();
  await flush();
  t.session.change("base");
  const second = t.session.save();
  t.release("write");
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(t.disk.get("/a")?.content).toBe("base");
  expect(t.dirty()).toBe(false);
  t.session.close();
});

it("autosaves edits that returned to the old baseline during an in-flight write", async () => {
  vi.useFakeTimers();
  const t = setup({ "/a": "base" }, { enabled: true, delay: 10 });
  t.session.open("/a");
  await flush();
  t.hold("write");
  t.session.change("first");
  await vi.advanceTimersByTimeAsync(10);
  t.session.change("base");
  t.release("write");
  await flush();
  await vi.advanceTimersByTimeAsync(10);
  expect(t.disk.get("/a")?.content).toBe("base");
  expect(t.dirty()).toBe(false);
  t.session.close();
});

it("refuses a save when the read supplied no version", async () => {
  const t = setup({ "/a": "base" });
  const read = t.io.read;
  t.io.read = async (path, force) => {
    const result = await read(path, force);
    return result.kind === "text" ? { ...result, version: undefined } : result;
  };
  t.session.open("/a");
  await flush();
  t.session.change("mine");
  expect(await t.session.save()).toBe(false);
  expect(t.host.saveFailed).toHaveBeenCalled();
  expect(t.disk.get("/a")?.content).toBe("base");
  t.session.close();
});

it("formats candidate content without a disk write before formatting finishes", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  t.session.change("draft");
  let finish!: (v: { content: string; size: number }) => void;
  const format = vi.fn(
    () =>
      new Promise<{ content: string; size: number }>((resolve) => {
        finish = resolve;
      }),
  );
  const saving = t.session.formatAndSave(format);
  expect(format).toHaveBeenCalledWith("/a", "draft");
  expect(t.disk.get("/a")?.content).toBe("base");
  t.touch("/a", "other window");
  finish({ content: "formatted draft", size: 15 });
  expect(await saving).toBe(false);
  expect(t.disk.get("/a")?.content).toBe("other window");
  expect(t.session.text()).toBe("formatted draft");
  expect(t.dirty()).toBe(true);
  expect(t.host.conflict).toHaveBeenCalled();
  t.session.close();
});

it.each(["typing", "reload", "navigation", "close", "save"])(
  "discards a formatting result superseded by %s",
  async (change) => {
    const t = setup({ "/a": "base", "/b": "other" });
    t.session.open("/a");
    await flush();
    let finish!: (v: { content: string; size: number }) => void;
    const saving = t.session.formatAndSave(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    if (change === "typing") t.session.change("new typing");
    if (change === "reload") {
      t.touch("/a", "external");
      t.session.reload();
      await flush();
    }
    if (change === "navigation") {
      t.session.open("/b");
      await flush();
    }
    if (change === "close") t.session.close();
    if (change === "save") {
      t.session.change("saved meanwhile");
      await t.session.save();
    }
    const before = t.session.text();
    finish({ content: "obsolete formatting", size: 19 });
    expect(await saving).toBe(false);
    expect(t.session.text()).toBe(before);
    expect(t.disk.get("/a")?.content).not.toBe("obsolete formatting");
    t.session.close();
  },
);

it("conditionally saves formatter-only line-ending changes", async () => {
  const t = setup({ "/a": "base\r\n" });
  t.session.open("/a");
  await flush();
  expect(
    await t.session.formatAndSave(async () => ({ content: "base\n", size: 5 })),
  ).toBe(true);
  expect(t.disk.get("/a")?.content).toBe("base\n");
  expect(t.dirty()).toBe(false);
  t.session.close();
});

it("keeps unsaved text after a formatter failure", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  t.session.change("draft");
  await expect(
    t.session.formatAndSave(async () => {
      throw new Error("format failed");
    }),
  ).rejects.toThrow("format failed");
  expect(t.session.text()).toBe("draft");
  expect(t.dirty()).toBe(true);
  expect(t.disk.get("/a")?.content).toBe("base");
  t.session.close();
});

it("a successful snapshot save does not make newer edits safe to close", async () => {
  const t = setup({ "/a": "base" });
  expect(t.session.isSaved()).toBe(false);
  t.session.open("/a");
  expect(t.session.isSaved()).toBe(false);
  await flush();
  expect(t.session.isSaved()).toBe(true);
  t.session.change("first");
  t.hold("write");
  const saving = t.session.save();
  await flush();
  t.session.change("newer");
  t.release("write");
  expect(await saving).toBe(true);
  expect(t.session.isSaved()).toBe(false);
  await t.session.save();
  expect(t.session.isSaved()).toBe(true);
  t.session.close();
  expect(t.session.isSaved()).toBe(false);
});

it("detaches a deleted draft from saves, reloads, formatting and autosave", async () => {
  vi.useFakeTimers();
  const t = setup({ "/a": "base" }, { enabled: true, delay: 10 });
  t.session.open("/a");
  await flush();
  t.session.change("draft");
  t.disk.delete("/a");
  t.session.detach();
  t.touch("/a", "base");
  await vi.advanceTimersByTimeAsync(20);
  expect(await t.session.save()).toBe(false);
  const format = vi.fn(async () => ({ content: "bad", size: 3 }));
  expect(await t.session.formatAndSave(format)).toBe(false);
  expect(format).not.toHaveBeenCalled();
  expect(t.session.reload({ force: true })).toBe(false);
  t.session.change("base");
  expect(t.session.isSaved()).toBe(false);
  expect(t.session.hasUnsavedChanges()).toBe(true);
  expect(t.session.isDetached()).toBe(true);
  expect(t.disk.get("/a")?.content).toBe("base");
  t.session.close();
});
it("recovery refuses even an identical replacement, then saves the draft to a new path", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  t.session.change("draft");
  t.disk.delete("/a");
  t.session.detach();
  t.touch("/a", "base");
  expect(await t.session.recover("/a")).toBe(false);
  expect(t.session.isDetached()).toBe(true);
  expect(t.disk.get("/a")?.content).toBe("base");
  expect(await t.session.recover("/copy")).toBe(true);
  expect(t.disk.get("/copy")?.content).toBe("draft");
  expect(t.session.isDetached()).toBe(false);
  t.session.change("next");
  expect(await t.session.save()).toBe(true);
  expect(t.disk.get("/copy")?.content).toBe("next");
  t.session.close();
});
it("detachment invalidates pending formatter output and queued saves", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  t.session.change("draft");
  let done!: (v: { content: string; size: number }) => void;
  const formatting = t.session.formatAndSave(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const saving = t.session.save();
  t.session.detach();
  done({ content: "stale", size: 5 });
  expect(await formatting).toBe(false);
  expect(await saving).toBe(false);
  expect(t.session.text()).toBe("draft");
  expect(t.disk.get("/a")?.content).toBe("base");
  t.session.close();
});
it("recovery keeps edits typed during its write dirty", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  t.session.change("draft");
  t.session.detach();
  t.disk.delete("/a");
  t.hold("write");
  const recovering = t.session.recover("/a");
  await flush();
  t.session.change("newer");
  t.release("write");
  expect(await recovering).toBe(true);
  expect(t.session.text()).toBe("newer");
  expect(t.session.hasUnsavedChanges()).toBe(true);
  expect(t.disk.get("/a")?.content).toBe("draft");
  t.session.close();
});
it("detachment invalidates an older conflict's Overwrite action", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  t.session.change("draft");
  t.touch("/a", "external");
  expect(await t.session.save()).toBe(false);
  const overwrite = t.host.conflict.mock.lastCall?.[1];
  t.session.detach();
  overwrite?.();
  await flush();
  expect(t.disk.get("/a")?.content).toBe("external");
  expect(t.session.isDetached()).toBe(true);
  t.session.close();
});

it("close acknowledgements distinguish edits, detachments and remounted sessions", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  t.session.change("draft");
  const acknowledged = t.session.closeRevision();
  expect(t.session.closeRevision()).toBe(acknowledged);
  t.session.change("new draft");
  expect(t.session.closeRevision()).not.toBe(acknowledged);
  const edited = t.session.closeRevision();
  t.session.detach();
  expect(t.session.closeRevision()).not.toBe(edited);
  const other = new DocumentSession(t.io, t.host);
  other.open("/a");
  await flush();
  other.change("draft");
  expect(other.closeRevision()).not.toBe(acknowledged);
  other.close();
  t.session.close();
});

it("the final quit seal rejects new text and resumes a deferred deletion on cancellation", async () => {
  const { sealEditors, releaseEditors } = await import("./quitBarrier");
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  t.session.change("approved draft");
  sealEditors("document-test");
  try {
    t.session.change("unaccepted edit");
    t.session.detach();
    expect(t.session.text()).toBe("approved draft");
    expect(t.session.isDetached()).toBe(false);
  } finally {
    releaseEditors("document-test");
  }
  expect(t.session.isDetached()).toBe(true);
  expect(t.session.text()).toBe("approved draft");
  t.session.close();
});

it("retains a detached draft when its recovery target is deleted before the save reply", async () => {
  const { planDocumentMutation } = await import("./documentMutations");
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  t.session.change("irreplaceable draft");
  t.disk.delete("/a");
  t.session.detach();
  const write = t.io.write;
  let deliver!: () => void;
  const reply = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  t.io.write = async (...args) => {
    const saved = await write(...args);
    await reply;
    return saved;
  };
  const recovery = t.session.recover("/a");
  await flush();
  expect(t.disk.get("/a")?.content).toBe("irreplaceable draft");
  t.disk.delete("/a");
  const plan = planDocumentMutation(
    [
      {
        id: 1,
        kind: "editor",
        spaceId: "local",
        path: "/a",
        title: "a",
        dirty: true,
        preview: false,
        detached: t.session.isDetached(),
      },
    ],
    [{ id: "local", env: { kind: "local" } }],
    {
      sequence: 1,
      workspace: { kind: "local" },
      kind: "deleted",
      paths: ["/a"],
    },
  );
  for (const _id of plan.deleted) t.session.detach();
  t.touch("/a", "unrelated replacement");
  deliver();
  await recovery;
  await flush();
  expect(t.session.text()).toBe("irreplaceable draft");
  expect(t.session.isDetached()).toBe(true);
  expect(t.session.hasUnsavedChanges()).toBe(true);
  t.session.close();
});

async function detachedRecovery() {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  t.session.change("draft");
  t.session.detach();
  t.disk.delete("/a");
  return t;
}
it("recovery refuses identical bytes in a different native file identity", async () => {
  const t = await detachedRecovery();
  const read = t.io.read;
  t.io.read = async (...args) => ({
    ...(await read(...args)),
    version: "replacement identity",
  });
  expect(await t.session.recover("/a")).toBe(false);
  expect(t.session.isDetached()).toBe(true);
  expect(t.session.text()).toBe("draft");
  expect(t.host.saved).not.toHaveBeenCalled();
  t.session.close();
});
it("recovery validation preserves newer typing and does not issue a later reload", async () => {
  const t = await detachedRecovery();
  t.hold("read");
  const recovery = t.session.recover("/a");
  await flush();
  t.session.change("newer draft");
  t.release("read");
  expect(await recovery).toBe(true);
  expect(t.session.text()).toBe("newer draft");
  expect(t.session.hasUnsavedChanges()).toBe(true);
  expect(t.log.filter((entry) => entry === "read /a")).toHaveLength(2);
  t.session.close();
});
it("failed recovery validation keeps the draft detached and reports the error", async () => {
  const t = await detachedRecovery();
  t.io.read = async () => {
    throw new Error("access lost");
  };
  expect(await t.session.recover("/a")).toBe(false);
  expect(t.session.isDetached()).toBe(true);
  expect(t.session.hasUnsavedChanges()).toBe(true);
  expect(t.host.saveFailed).toHaveBeenCalledWith("/a", expect.any(Error));
  t.session.close();
});
it("closing a draft releases pending destination tracking before the write replies", async () => {
  const t = await detachedRecovery();
  const dispose = vi.fn();
  t.io.observeRecovery = () => ({ changed: () => false, dispose });
  t.hold("write");
  const recovery = t.session.recover("/a");
  await flush();
  t.session.close();
  expect(dispose).toHaveBeenCalled();
  t.release("write");
  expect(await recovery).toBe(false);
  expect(t.host.saved).not.toHaveBeenCalled();
});
it("a final quit barrier cannot be crossed by a late recovery reply", async () => {
  const { sealEditors, releaseEditors } = await import("./quitBarrier");
  const t = await detachedRecovery();
  t.hold("write");
  const recovery = t.session.recover("/a");
  await flush();
  sealEditors("recover-test");
  try {
    t.release("write");
    expect(await recovery).toBe(false);
    expect(t.session.isDetached()).toBe(true);
    expect(t.session.hasUnsavedChanges()).toBe(true);
    expect(t.session.text()).toBe("draft");
  } finally {
    releaseEditors("recover-test");
    t.session.close();
  }
});
it.each(["rename", "lost listener", "deferred delete"])(
  "recovery observes %s before binding, even when the returned disk version is unchanged",
  async (kind) => {
    const { subscribeDocumentMutations } = await import("./documentMutations");
    const { observeRecoveryTarget } = await import("./recoveryTarget");
    const { workspaceScopeKey } = await import("@/modules/workspace/env");
    const { sealEditors, releaseEditors } = await import("./quitBarrier");
    const t = await detachedRecovery();
    const env = { kind: "local" } as const;
    let receive!: (
      event: import("./documentMutations").DocumentMutation,
    ) => void;
    const apply = vi.fn();
    const stop = subscribeDocumentMutations(
      async (listener) => {
        receive = listener;
        return () => {};
      },
      apply,
      vi.fn(),
    );
    await flush();
    t.io.observeRecovery = (path) =>
      observeRecoveryTarget(path, workspaceScopeKey(env));
    t.hold("write");
    const recovery = t.session.recover("/a");
    await flush();
    if (kind === "lost listener") stop();
    else if (kind === "rename") {
      receive({
        sequence: 1,
        workspace: env,
        kind: "renamed",
        from: "/a",
        to: "/b",
      });
      receive({
        sequence: 2,
        workspace: env,
        kind: "renamed",
        from: "/b",
        to: "/a",
      });
    } else {
      sealEditors("recover-events");
      receive({ sequence: 1, workspace: env, kind: "deleted", paths: ["/a"] });
      expect(apply).not.toHaveBeenCalled();
      // Release after the observation, before its deferred tab update.
      releaseEditors("recover-events");
    }
    t.release("write");
    expect(await recovery).toBe(false);
    expect(t.session.isDetached()).toBe(true);
    expect(t.session.text()).toBe("draft");
    expect(t.host.saveFailed).toHaveBeenCalledWith("/a", expect.any(Error));
    stop();
    t.session.close();
  },
);

it("unavailable mutation coverage refuses recovery before creating a file", async () => {
  const { observeRecoveryTarget, recoveryMutationCoverage } = await import(
    "./recoveryTarget"
  );
  const t = await detachedRecovery();
  recoveryMutationCoverage(false);
  t.io.observeRecovery = (path) => observeRecoveryTarget(path, "local");
  expect(await t.session.recover("/a")).toBe(false);
  expect(t.disk.has("/a")).toBe(false);
  expect(t.session.isDetached()).toBe(true);
  recoveryMutationCoverage(true);
  expect(await t.session.recover("/a")).toBe(true);
  recoveryMutationCoverage(false);
  t.session.close();
});
it("recovery observes destination changes during its final read", async () => {
  const t = await detachedRecovery();
  let changed = false;
  t.io.observeRecovery = () => ({ changed: () => changed, dispose: vi.fn() });
  t.hold("read");
  const recovery = t.session.recover("/a");
  await flush();
  changed = true;
  t.release("read");
  expect(await recovery).toBe(false);
  expect(t.session.text()).toBe("draft");
  expect(t.session.isDetached()).toBe(true);
  expect(t.host.saved).not.toHaveBeenCalled();
  t.session.close();
});

it("a failed formatter restores autosave for the unchanged dirty draft", async () => {
  vi.useFakeTimers();
  const t = setup({ "/a": "base" }, { enabled: true, delay: 50 });
  t.session.open("/a");
  await flush();
  t.session.change("draft");
  await expect(
    t.session.formatAndSave(async () => {
      throw new Error("formatter unavailable");
    }),
  ).rejects.toThrow("formatter unavailable");
  await vi.advanceTimersByTimeAsync(60);
  expect(t.disk.get("/a")?.content).toBe("draft");
  expect(t.session.isSaved()).toBe(true);
  t.session.close();
});
it("a formatter save conflict does not start an endless autosave retry", async () => {
  vi.useFakeTimers();
  const t = setup({ "/a": "base" }, { enabled: true, delay: 50 });
  t.session.open("/a");
  await flush();
  t.session.change("draft");
  t.touch("/a", "external");
  expect(
    await t.session.formatAndSave(async () => ({
      content: "formatted",
      size: 9,
    })),
  ).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  expect(t.host.conflict).toHaveBeenCalledOnce();
  expect(t.disk.get("/a")?.content).toBe("external");
  t.session.close();
});
it("a superseded formatter restores autosave after a dirty reload invalidates its candidate", async () => {
  vi.useFakeTimers();
  const t = setup({ "/a": "base" }, { enabled: true, delay: 50 });
  t.session.open("/a");
  await flush();
  t.session.change("draft");
  let finish!: (result: { content: string; size: number }) => void;
  const formatting = t.session.formatAndSave(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  t.session.adoptDiskText("base", "base");
  finish({ content: "obsolete format", size: 15 });
  expect(await formatting).toBe(false);
  await vi.advanceTimersByTimeAsync(60);
  expect(t.disk.get("/a")?.content).toBe("draft");
  t.session.close();
});
it.each(["before", "during"])(
  "failed formatting preserves an autosave pause from a save conflict %s preparation",
  async (when) => {
    vi.useFakeTimers();
    const t = setup({ "/a": "base" }, { enabled: true, delay: 50 });
    t.session.open("/a");
    await flush();
    t.session.change("draft");
    t.touch("/a", "external");
    if (when === "before") expect(await t.session.save()).toBe(false);
    let fail!: (error: Error) => void;
    const formatting = t.session.formatAndSave(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const rejected = expect(formatting).rejects.toThrow("formatter failed");
    if (when === "during") expect(await t.session.save()).toBe(false);
    fail(new Error("formatter failed"));
    await rejected;
    await vi.advanceTimersByTimeAsync(500);
    expect(t.host.conflict).toHaveBeenCalledOnce();
    expect(t.disk.get("/a")?.content).toBe("external");
    t.session.close();
  },
);

it.each([false, true])(
  "discard retains newer edits even when autosave already made them clean (%s)",
  async (saved) => {
    const t = setup({ "/a": "disk changes" });
    t.session.open("/a");
    await flush();
    t.session.change("old draft");
    const discard = t.session.prepareDiscard();
    t.session.change("new draft");
    if (saved) {
      expect(await t.session.save()).toBe(true);
      expect(t.session.hasUnsavedChanges()).toBe(true);
      expect(t.session.isSaved()).toBe(false);
      expect(t.dirty()).toBe(true);
    }
    t.touch("/a", "HEAD");
    expect(t.session.reload()).toBe(false);
    discard.complete();
    discard.dispose();
    await flush();
    expect(t.session.text()).toBe("new draft");
    expect(t.session.hasUnsavedChanges()).toBe(true);
    expect(await t.session.save()).toBe(true);
    expect(t.disk.get("/a")?.content).toBe("new draft");
    t.session.close();
  },
);
it("discard reloads an unchanged buffer but preserves typing during its read", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  t.session.change("confirmed edits");
  const first = t.session.prepareDiscard();
  t.touch("/a", "HEAD");
  first.complete();
  await flush();
  expect(t.session.text()).toBe("HEAD");
  expect(t.session.isSaved()).toBe(true);
  const second = t.session.prepareDiscard();
  t.touch("/a", "new HEAD");
  t.hold("read");
  second.complete();
  t.session.change("typing during reload");
  t.release("read");
  await flush();
  expect(t.session.text()).toBe("typing during reload");
  expect(t.session.hasUnsavedChanges()).toBe(true);
  t.session.close();
});
it("discard detaches retained edits when its untracked file was deleted", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  const discard = t.session.prepareDiscard();
  t.session.change("new work");
  t.disk.delete("/a");
  discard.complete();
  await flush();
  expect(t.session.isDetached()).toBe(true);
  expect(t.session.text()).toBe("new work");
  expect(t.host.saveFailed).toHaveBeenCalled();
  t.session.close();
});
it("discard cancellation releases reload protection without discarding the draft", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  const discard = t.session.prepareDiscard();
  expect(t.session.reload()).toBe(false);
  discard.dispose();
  await flush();
  expect(t.session.reload()).toBe(true);
  discard.complete();
  await flush();
  expect(t.session.text()).toBe("base");
  t.session.close();
});
it("late pre-discard save replies cannot mark the retained newer draft clean", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  const discard = t.session.prepareDiscard();
  t.session.change("new draft");
  let reply!: () => void;
  const wait = new Promise<void>((resolve) => {
    reply = resolve;
  });
  const write = t.io.write;
  t.io.write = async (...args) => {
    const result = await write(...args);
    await wait;
    return result;
  };
  const save = t.session.save();
  await flush();
  t.touch("/a", "HEAD");
  discard.complete();
  await flush();
  reply();
  expect(await save).toBe(false);
  expect(t.session.text()).toBe("new draft");
  expect(t.session.hasUnsavedChanges()).toBe(true);
  t.session.close();
});
it("discard completion waits for quit cancellation before changing the editor", async () => {
  const { sealEditors, releaseEditors } = await import("./quitBarrier");
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  const discard = t.session.prepareDiscard();
  t.session.change("new draft");
  t.touch("/a", "HEAD");
  const cancel = vi.fn();
  sealEditors("discard-test", cancel);
  discard.complete();
  discard.dispose();
  expect(cancel).toHaveBeenCalledOnce();
  expect(t.session.text()).toBe("new draft");
  releaseEditors("discard-test");
  await flush();
  expect(t.session.text()).toBe("new draft");
  expect(t.session.hasUnsavedChanges()).toBe(true);
  t.session.close();
});
it("a discard snapshot cannot strand a loading or replacement document", async () => {
  const t = setup({ "/a": "a", "/b": "b" });
  t.hold("read");
  t.session.open("/a");
  const loading = t.session.prepareDiscard();
  t.release("read");
  await flush();
  loading.complete();
  expect(t.session.text()).toBe("a");
  const old = t.session.prepareDiscard();
  t.session.open("/b");
  await flush();
  old.complete();
  expect(t.session.text()).toBe("b");
  expect(t.session.isSaved()).toBe(true);
  t.session.close();
});
it("recovery closing during native handle acquisition cleans up without writing", async () => {
  const t = await detachedRecovery();
  const dispose = vi.fn();
  let acquired!: (value: {
    changed: () => boolean;
    dispose: () => void;
  }) => void;
  t.io.observeRecovery = () =>
    new Promise((resolve) => {
      acquired = resolve;
    });
  const recovery = t.session.recover("/a");
  await flush();
  t.session.close();
  acquired({ changed: () => false, dispose });
  expect(await recovery).toBe(false);
  expect(dispose).toHaveBeenCalledOnce();
  expect(t.disk.has("/a")).toBe(false);
});
it("closing during the final native recovery check cannot rebind the document", async () => {
  const t = await detachedRecovery();
  let checked!: (changed: boolean) => void;
  const changed = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          checked = resolve;
        }),
    );
  const dispose = vi.fn();
  t.io.observeRecovery = () => ({ changed, dispose });
  const recovery = t.session.recover("/a");
  await flush();
  t.session.close();
  checked(false);
  expect(await recovery).toBe(false);
  expect(t.host.saved).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalled();
});
it("discard pauses the confirmed draft's autosave and restores it on failure", async () => {
  vi.useFakeTimers();
  const t = setup({ "/a": "base" }, { enabled: true, delay: 50 });
  t.session.open("/a");
  await flush();
  t.session.change("confirmed draft");
  const discard = t.session.prepareDiscard();
  await vi.advanceTimersByTimeAsync(100);
  expect(t.disk.get("/a")?.content).toBe("base");
  discard.dispose();
  await vi.advanceTimersByTimeAsync(60);
  expect(t.disk.get("/a")?.content).toBe("confirmed draft");
  t.session.close();
});
it("a partially failed discard retains even autosaved newer edits and revalidates their baseline", async () => {
  const t = setup({ "/a": "base" });
  t.session.open("/a");
  await flush();
  const discard = t.session.prepareDiscard();
  t.session.change("new draft");
  expect(await t.session.save()).toBe(true);
  t.touch("/a", "partially discarded disk");
  discard.dispose();
  await flush();
  expect(t.session.text()).toBe("new draft");
  expect(t.session.hasUnsavedChanges()).toBe(true);
  expect(await t.session.save()).toBe(true);
  expect(t.disk.get("/a")?.content).toBe("new draft");
  t.session.close();
});

it("a remotely prepared loading document protects edits after its initial read", async () => {
  const t = setup({ "/a": "before" });
  t.hold("read");
  t.session.open("/a");
  const prep = t.session.prepareDiscard(true);
  t.release("read");
  await flush();
  expect(t.doc()?.status).toBe("ready");
  t.session.change("new draft");
  await t.session.save();
  t.touch("/a", "HEAD");
  expect(t.session.reload()).toBe(false);
  prep.complete();
  await flush();
  expect(t.session.text()).toBe("new draft");
  expect(t.session.hasUnsavedChanges()).toBe(true);
  t.session.close();
});
it("discard completion before initial loading finishes restarts the read", async () => {
  const t = setup({ "/a": "before" });
  t.hold("read");
  t.session.open("/a");
  const prep = t.session.prepareDiscard(true);
  t.touch("/a", "HEAD");
  prep.complete();
  t.release("read");
  await flush();
  expect(t.doc()?.status).toBe("ready");
  expect(t.session.text()).toBe("HEAD");
  expect(t.session.isSaved()).toBe(true);
  t.session.close();
});

it("unmatched identity candidates preserve an in-flight save and autosave timing", async () => {
  const t = setup({ "/a": "disk" }, { enabled: true, delay: 100 });
  t.session.open("/a");
  await flush();
  t.session.change("new work");
  t.hold("write");
  const saving = t.session.save();
  const candidate = t.session.stageDiscard(true);
  expect(t.session.hasUnsavedChanges()).toBe(true);
  candidate.select(false);
  t.release("write");
  expect(await saving).toBe(true);
  expect(t.session.isSaved()).toBe(true);
  expect(t.session.text()).toBe("new work");
  t.session.close();
});
it("a matching identity keeps the revision from before the delayed lookup", async () => {
  const t = setup({ "/a": "disk" });
  t.session.open("/a");
  await flush();
  const candidate = t.session.stageDiscard();
  t.session.change("typed during identity lookup");
  await t.session.save();
  expect(t.session.isSaved()).toBe(false);
  const preparation = candidate.select(true);
  t.touch("/a", "HEAD");
  preparation.complete();
  await flush();
  expect(t.session.text()).toBe("typed during identity lookup");
  expect(t.session.hasUnsavedChanges()).toBe(true);
  t.session.close();
});
it("unmatched candidates replay only watcher reads suppressed during lookup", async () => {
  const t = setup({ "/a": "disk" });
  t.session.open("/a");
  await flush();
  const candidate = t.session.stageDiscard(true);
  t.touch("/a", "external edit");
  expect(t.session.reload()).toBe(false);
  candidate.select(false);
  await flush();
  expect(t.session.text()).toBe("external edit");
  expect(t.session.isSaved()).toBe(true);
  const reads = t.log.length;
  t.session.stageDiscard(true).select(false);
  await flush();
  expect(t.log.length).toBe(reads);
  t.session.close();
});
it("a candidate resolved after navigation cannot change the replacement document", async () => {
  const t = setup({ "/a": "a", "/b": "b" });
  t.session.open("/a");
  await flush();
  const candidate = t.session.stageDiscard(true);
  t.session.open("/b");
  await flush();
  candidate.select(true).complete();
  await flush();
  expect(t.session.text()).toBe("b");
  expect(t.session.isSaved()).toBe(true);
  t.session.close();
});
