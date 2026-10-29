import { expect, it, vi } from "vitest";
vi.mock("@/modules/settings/store", () => ({ setLastWslDistro: vi.fn() }));
import type { EditorTab, Tab } from "@/modules/tabs";
import { DocumentSession } from "./documentSession";
import { noteRetarget } from "./pathRetarget";
import {
  documentTabsInEnvironment,
  planDocumentMutation,
  subscribeDocumentMutations,
  type DocumentMutation,
} from "./documentMutations";
const ubuntu = { kind: "wsl", distro: "Ubuntu" } as const;
const debian = { kind: "wsl", distro: "Debian" } as const;
const local = { kind: "local" } as const;
const spaces = [
  { id: "u", env: ubuntu },
  { id: "d", env: debian },
  { id: "l", env: local },
];
const tab = (
  id: number,
  spaceId: string,
  path = "/work/file.ts",
): EditorTab => ({
  id,
  spaceId,
  path,
  kind: "editor",
  title: path,
  dirty: false,
  preview: false,
});
const move: DocumentMutation = {
  sequence: 1,
  workspace: ubuntu,
  kind: "renamed",
  from: "/work",
  to: "/moved",
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

it("only retargets documents in the originating environment, including cold and markdown tabs", () => {
  const tabs: Tab[] = [
    tab(1, "u"),
    tab(2, "d"),
    tab(3, "l"),
    tab(4, "missing"),
    { ...tab(5, "u"), cold: true },
    {
      id: 6,
      kind: "markdown",
      spaceId: "u",
      path: "/work/doc.md",
      title: "doc",
    },
    tab(7, "u", "/worker/a"),
  ];
  const plan = planDocumentMutation(tabs, spaces, move);
  expect(plan.renamed.map((t) => [t.id, t.path, t.preserveBuffer])).toEqual([
    [1, "/moved/file.ts", true],
    [5, "/moved/file.ts", false],
    [6, "/moved/doc.md", false],
  ]);
  expect(
    planDocumentMutation(tabs, spaces, {
      sequence: 2,
      workspace: ubuntu,
      kind: "deleted",
      paths: ["/work"],
    }).deleted,
  ).toEqual([1, 5, 6]);
});
it("host files in WSL spaces share the host scope, while missing owners never default to host", () => {
  const tabs = [
    tab(1, "u", "C:\\repo\\a"),
    tab(2, "l", "C:/repo/a"),
    tab(3, "missing", "C:/repo/a"),
  ];
  expect(
    documentTabsInEnvironment(tabs, spaces, local).map((t) => t.id),
  ).toEqual([1, 2]);
  expect(documentTabsInEnvironment(tabs, spaces, ubuntu)).toEqual([]);
});
it("refreshes an open replacement destination without retargeting or discarding it", () => {
  const plan = planDocumentMutation(
    [
      tab(1, "u", "/work/a"),
      { ...tab(2, "u", "/moved/a"), dirty: true },
      tab(3, "d", "/moved/a"),
    ],
    spaces,
    move,
  );
  expect(plan.renamed.map((t) => t.id)).toEqual([1]);
  expect(plan.refresh).toEqual([2]);
  expect(plan.deleted).toEqual([]);
});
it("broadcasts rename chains to two windows while retaining each dirty buffer", async () => {
  const receivers: ((event: DocumentMutation) => void)[] = [];
  const windows = [1, 2].map((id) => {
    let tabs: Tab[] = [tab(id, "u")];
    const session = new DocumentSession(
      {
        read: async () => ({
          kind: "text",
          content: "base",
          size: 4,
          mtime: 1,
          version: "base",
        }),
        write: async () => ({ kind: "saved", version: "new" }),
      },
      {
        state: () => {},
        dirty: () => {},
        saved: () => {},
        saveFailed: () => {},
        conflict: () => {},
        released: () => {},
        autoSave: () => ({ enabled: false, delay: 10 }),
      },
    );
    session.open("/work/file.ts");
    const deleted: number[] = [];
    const stop = subscribeDocumentMutations(
      async (receive) => {
        receivers.push(receive);
        return () => {};
      },
      (event) => {
        const plan = planDocumentMutation(tabs, spaces, event);
        for (const change of plan.renamed) {
          noteRetarget(change.from, change.path);
          tabs = tabs.map((t) =>
            t.id === change.id ? { ...t, path: change.path } : t,
          );
          session.open(change.path);
        }
        deleted.push(...plan.deleted);
      },
      () => {
        throw new Error("unexpected listener failure");
      },
    );
    return { session, stop, deleted, tabs: () => tabs };
  });
  await flush();
  windows.forEach((w, i) => {
    w.session.change(`draft ${i}`);
  });
  for (const event of [
    move,
    { ...move, sequence: 2, from: "/moved", to: "/final" },
  ])
    receivers.forEach((receive) => {
      receive(event);
    });
  for (const [i, w] of windows.entries()) {
    expect(w.tabs()[0]).toMatchObject({ path: "/final/file.ts" });
    expect(w.session.text()).toBe(`draft ${i}`);
    expect(w.session.isSaved()).toBe(false);
  }
  receivers.forEach((receive) => {
    receive({
      sequence: 3,
      workspace: debian,
      kind: "deleted",
      paths: ["/final"],
    });
  });
  expect(windows.map((w) => w.deleted)).toEqual([[], []]);
  receivers.forEach((receive) => {
    receive({
      sequence: 4,
      workspace: ubuntu,
      kind: "deleted",
      paths: ["/final"],
    });
  });
  expect(windows.map((w) => w.deleted)).toEqual([[1], [2]]);
  windows.forEach((w) => {
    w.stop();
    w.session.close();
  });
});
it("ignores duplicates and cleans up a registration completed after disposal", async () => {
  let receive!: (e: DocumentMutation) => void;
  let finish!: (stop: () => void) => void;
  const apply = vi.fn(),
    unlisten = vi.fn(),
    ready = vi.fn();
  const stop = subscribeDocumentMutations(
    (callback) => {
      receive = callback;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    apply,
    vi.fn(),
    ready,
  );
  receive(move);
  receive(move);
  expect(apply).toHaveBeenCalledTimes(1);
  stop();
  receive({ ...move, sequence: 2 });
  finish(unlisten);
  await flush();
  expect(apply).toHaveBeenCalledTimes(1);
  expect(unlisten).toHaveBeenCalledTimes(1);
  expect(ready).not.toHaveBeenCalled();
});
it("surfaces registration failure and suppresses errors after disposal", async () => {
  const failed = vi.fn();
  subscribeDocumentMutations(
    async () => {
      throw new Error("unavailable");
    },
    vi.fn(),
    failed,
  );
  await flush();
  expect(failed).toHaveBeenCalledTimes(1);
  const stop = subscribeDocumentMutations(
    async () => {
      throw new Error("obsolete");
    },
    vi.fn(),
    failed,
  );
  stop();
  await flush();
  expect(failed).toHaveBeenCalledTimes(1);
});
it("retained deleted drafts never follow replacement-file events", () => {
  const draft = { ...tab(1, "u"), dirty: true, detached: true };
  expect(planDocumentMutation([draft], spaces, move)).toEqual({
    renamed: [],
    deleted: [],
    refresh: [],
  });
  expect(
    planDocumentMutation([draft], spaces, {
      sequence: 2,
      workspace: ubuntu,
      kind: "deleted",
      paths: ["/work"],
    }).deleted,
  ).toEqual([]);
});

it("renames and deletion cancel final verification before applying their complete identity chain", async () => {
  const { sealEditors, releaseEditors, editorMutationsPending } = await import(
    "./quitBarrier"
  );
  const { QuitApproval } = await import("@/app/hooks/quitApproval");
  const session = new DocumentSession(
    {
      read: async () => ({
        kind: "text",
        content: "base",
        size: 4,
        mtime: 1,
        version: "base",
      }),
      write: async () => ({ kind: "saved", version: "saved" }),
    },
    {
      state: vi.fn(),
      dirty: vi.fn(),
      saved: vi.fn(),
      saveFailed: vi.fn(),
      conflict: vi.fn(),
      released: vi.fn(),
      autoSave: () => ({ enabled: false, delay: 10 }),
    },
  );
  session.open("/a");
  await flush();
  session.change("unsaved draft");
  let finishCancel!: (cancelled: boolean) => void;
  let finishFlush!: (saved: boolean) => void;
  const host = {
    read: () => new Map([[1, session.closeRevision()]]),
    flush: () =>
      new Promise<boolean>((resolve) => {
        finishFlush = resolve;
      }),
    answer: vi.fn().mockResolvedValue(undefined),
    changed: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishCancel = resolve;
        }),
    ),
    resumed: vi.fn(),
    failed: vi.fn(),
    interrupted: vi.fn(),
  };
  const approval = new QuitApproval(host);
  const first = { round: 7, ticket: 1, verify: false };
  const last = { round: 7, ticket: 3, verify: true };
  approval.begin(first);
  approval.approve(first, host.read());
  approval.begin(last);
  const verifying = approval.verify(last);
  let receive!: (event: DocumentMutation) => void;
  let path = "/a";
  const applied: number[] = [];
  const stop = subscribeDocumentMutations(
    async (listener) => {
      receive = listener;
      return () => {};
    },
    (event) => {
      // The reservation prevents another final seal between two path updates.
      expect(sealEditors("too-early")).toBe(false);
      if (event.kind === "renamed") {
        expect(event.from).toBe(path);
        noteRetarget(event.from, event.to);
        path = event.to;
        session.open(path);
      } else {
        expect(event.paths).toContain(path);
        session.detach();
      }
      applied.push(event.sequence);
    },
    (error) => {
      throw error;
    },
  );
  try {
    receive({
      sequence: 1,
      workspace: local,
      kind: "renamed",
      from: "/a",
      to: "/b",
    });
    receive({
      sequence: 2,
      workspace: local,
      kind: "renamed",
      from: "/b",
      to: "/c",
    });
    receive({ sequence: 3, workspace: local, kind: "deleted", paths: ["/c"] });
    expect(applied).toEqual([]);
    expect(host.cancel).toHaveBeenCalledExactlyOnceWith(7);
    expect(editorMutationsPending()).toBe(true);
    finishFlush(true);
    await verifying;
    expect(host.answer).not.toHaveBeenCalledWith(last, true);
    finishCancel(true);
    await flush();
    expect(applied).toEqual([1, 2, 3]);
    expect(host.interrupted).toHaveBeenCalledOnce();
    expect(path).toBe("/c");
    expect(session.text()).toBe("unsaved draft");
    expect(session.isDetached()).toBe(true);
    expect(editorMutationsPending()).toBe(false);
    expect(sealEditors("after-events")).toBe(true);
    releaseEditors("after-events");
  } finally {
    stop();
    approval.dispose();
    releaseEditors("7:3");
    session.close();
  }
});
it("disposing a mutation listener releases its reservation without replaying into a replacement page", async () => {
  const { sealEditors, releaseEditors, editorMutationsPending } = await import(
    "./quitBarrier"
  );
  sealEditors("local-closing");
  let receive!: (event: DocumentMutation) => void;
  const apply = vi.fn();
  const stop = subscribeDocumentMutations(
    async (listener) => {
      receive = listener;
      return () => {};
    },
    apply,
    vi.fn(),
  );
  receive(move);
  expect(editorMutationsPending()).toBe(true);
  stop();
  expect(editorMutationsPending()).toBe(false);
  releaseEditors("local-closing");
  await flush();
  expect(apply).not.toHaveBeenCalled();
});
it("a refused local close replays all waiting renames in order", async () => {
  const { sealEditors, releaseEditors } = await import("./quitBarrier");
  sealEditors("local-closing");
  let receive!: (event: DocumentMutation) => void;
  const applied: number[] = [];
  const stop = subscribeDocumentMutations(
    async (listener) => {
      receive = listener;
      return () => {};
    },
    (event) => applied.push(event.sequence),
    vi.fn(),
  );
  receive(move);
  receive({ ...move, sequence: 2 });
  expect(applied).toEqual([]);
  releaseEditors("local-closing");
  await flush();
  expect(applied).toEqual([1, 2]);
  stop();
});
