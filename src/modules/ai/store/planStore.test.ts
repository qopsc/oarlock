import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createDir: vi.fn(),
  canonicalize: vi.fn(),
}));

vi.mock("@/modules/ai/lib/native", () => ({
  native,
  createNative: () => native,
}));

import { type QueuedEdit, usePlanStore } from "@/modules/ai/store/planStore";

function edit(partial: Partial<QueuedEdit> = {}): QueuedEdit {
  return {
    id: "q-1",
    kind: "edit",
    path: "/repo/a.ts",
    originalContent: "old",
    proposedContent: "new",
    isNewFile: false,
    baseVersion: "v1",
    ...partial,
  };
}

function dir(partial: Partial<QueuedEdit> = {}): QueuedEdit {
  return edit({
    kind: "create_directory",
    originalContent: "",
    proposedContent: "",
    description: "Create directory",
    ...partial,
  });
}

const queueIds = () => usePlanStore.getState().queue.map((q) => q.id);

describe("plan mode store", () => {
  beforeEach(() => {
    usePlanStore.setState({ active: false, queue: [] });
    native.readFile.mockReset().mockResolvedValue({
      kind: "text",
      content: "old",
      size: 3,
      version: "v1",
    });
    native.writeFile.mockReset().mockResolvedValue({ version: "v2" });
    native.createDir.mockReset().mockResolvedValue(undefined);
    native.canonicalize
      .mockReset()
      .mockImplementation(async (path: string) => path);
  });

  it("keeps the queue when enabling and clears it when disabling", () => {
    usePlanStore.getState().enqueue(edit());
    usePlanStore.getState().enqueue(edit({ id: "q-2" }));

    usePlanStore.getState().enable();
    expect(usePlanStore.getState().active).toBe(true);
    expect(usePlanStore.getState().queue).toHaveLength(2);

    usePlanStore.getState().disable();
    expect(usePlanStore.getState().active).toBe(false);
    expect(usePlanStore.getState().queue).toEqual([]);
  });

  it("toggle clears queued edits only when switching off", () => {
    usePlanStore.getState().toggle();
    expect(usePlanStore.getState().active).toBe(true);

    usePlanStore.getState().enqueue(edit());
    usePlanStore.getState().toggle();

    expect(usePlanStore.getState().active).toBe(false);
    expect(usePlanStore.getState().queue).toEqual([]);
  });

  it("removeOne drops only the matching edit", () => {
    usePlanStore.getState().enqueue(edit({ id: "q-1" }));
    usePlanStore.getState().enqueue(edit({ id: "q-2" }));

    usePlanStore.getState().removeOne("q-1");

    expect(queueIds()).toEqual(["q-2"]);
  });

  it("applies file writes in queue order and reports success per item", async () => {
    usePlanStore.getState().enqueue(edit({ id: "q-1", path: "/repo/a.ts" }));
    usePlanStore.getState().enqueue(edit({ id: "q-2", path: "/repo/b.ts" }));

    const results = await usePlanStore.getState().applyAll();

    expect(native.writeFile.mock.calls).toEqual([
      ["/repo/a.ts", "new", "v1"],
      ["/repo/b.ts", "new", "v1"],
    ]);
    expect(results).toEqual([
      { id: "q-1", ok: true },
      { id: "q-2", ok: true },
    ]);
    expect(usePlanStore.getState().queue).toEqual([]);
  });

  it("routes create_directory edits to mkdir instead of write", async () => {
    usePlanStore.getState().enqueue(dir({ path: "/repo/new-dir" }));

    const results = await usePlanStore.getState().applyAll();

    expect(native.createDir).toHaveBeenCalledWith("/repo/new-dir");
    expect(native.writeFile).not.toHaveBeenCalled();
    expect(results).toEqual([{ id: "q-1", ok: true }]);
  });

  it("captures a failed edit in its result, keeps it with its error and drains the rest", async () => {
    usePlanStore.getState().enqueue(edit({ id: "q-1", path: "/repo/blocked" }));
    usePlanStore.getState().enqueue(edit({ id: "q-2", path: "/repo/fine" }));
    native.writeFile.mockImplementation((path: string) =>
      path === "/repo/blocked"
        ? Promise.reject(new Error("denied"))
        : Promise.resolve({ version: "v2" }),
    );

    const results = await usePlanStore.getState().applyAll();

    expect(results[0]).toMatchObject({ id: "q-1", ok: false });
    expect(String(results[0].error)).toContain("denied");
    expect(results[1]).toEqual({ id: "q-2", ok: true });
    // The failed edit stays in the panel with its error; the written one leaves.
    expect(usePlanStore.getState().queue).toEqual([
      expect.objectContaining({ id: "q-1", error: results[0].error }),
    ]);
  });

  it("refuses denied paths at the mutation boundary without touching disk", async () => {
    usePlanStore.getState().enqueue(edit({ id: "q-1", path: "/repo/.env" }));
    usePlanStore
      .getState()
      .enqueue(dir({ id: "q-2", path: "/home/me/.ssh/keys" }));

    const results = await usePlanStore.getState().applyAll();

    expect(results.map((r) => r.ok)).toEqual([false, false]);
    expect(results[0].error).toMatch(/^Refused/);
    expect(native.writeFile).not.toHaveBeenCalled();
    expect(native.createDir).not.toHaveBeenCalled();
    // Refused edits stay visible with the refusal rather than vanishing.
    expect(
      usePlanStore
        .getState()
        .queue.map((q) => [q.id, q.error?.startsWith("Refused")]),
    ).toEqual([
      ["q-1", true],
      ["q-2", true],
    ]);
  });

  it("refuses a path that became a link to a secret after it was queued", async () => {
    usePlanStore.getState().enqueue(edit({ path: "/repo/notes.txt" }));
    native.canonicalize.mockImplementation(async (path: string) =>
      path === "/repo/notes.txt" ? "/home/me/.ssh/config" : path,
    );

    const results = await usePlanStore.getState().applyAll();

    expect(results).toEqual([
      { id: "q-1", ok: false, error: expect.stringContaining(".ssh") },
    ]);
    expect(native.writeFile).not.toHaveBeenCalled();
  });

  it("writes to the canonical path", async () => {
    usePlanStore.getState().enqueue(edit({ path: "/repo/link.ts" }));
    native.canonicalize.mockImplementation(async (path: string) =>
      path === "/repo/link.ts" ? "/repo/src/real.ts" : path,
    );

    await usePlanStore.getState().applyAll();

    expect(native.writeFile).toHaveBeenCalledWith(
      "/repo/src/real.ts",
      "new",
      "v1",
    );
  });

  it("keeps edits enqueued while applyAll is pending and applies them later", async () => {
    let releaseWrite: (() => void) | undefined;
    native.writeFile.mockImplementation(
      (path: string) =>
        new Promise<{ version: string }>((resolve) => {
          if (path === "/repo/first")
            releaseWrite = () => resolve({ version: "v2" });
          else resolve({ version: "v2" });
        }),
    );
    usePlanStore.getState().enqueue(edit({ id: "q-1", path: "/repo/first" }));

    const applying = usePlanStore.getState().applyAll();
    await vi.waitFor(() => expect(releaseWrite).toBeDefined());
    // Queued by the agent while the first write is still in flight.
    usePlanStore.getState().enqueue(edit({ id: "q-2", path: "/repo/second" }));
    releaseWrite?.();

    expect(await applying).toEqual([{ id: "q-1", ok: true }]);
    expect(queueIds()).toEqual(["q-2"]);

    expect(await usePlanStore.getState().applyAll()).toEqual([
      { id: "q-2", ok: true },
    ]);
    expect(usePlanStore.getState().queue).toEqual([]);
  });

  it("skips an edit rejected while earlier writes are running", async () => {
    let releaseWrite: (() => void) | undefined;
    native.writeFile.mockImplementation(
      (path: string) =>
        new Promise<{ version: string }>((resolve) => {
          if (path === "/repo/first")
            releaseWrite = () => resolve({ version: "v2" });
          else resolve({ version: "v2" });
        }),
    );
    usePlanStore.getState().enqueue(edit({ id: "q-1", path: "/repo/first" }));
    usePlanStore.getState().enqueue(edit({ id: "q-2", path: "/repo/second" }));
    usePlanStore.getState().enqueue(edit({ id: "q-3", path: "/repo/third" }));

    const applying = usePlanStore.getState().applyAll();
    await vi.waitFor(() => expect(releaseWrite).toBeDefined());
    usePlanStore.getState().removeOne("q-2");
    releaseWrite?.();

    expect(await applying).toEqual([
      { id: "q-1", ok: true },
      { id: "q-3", ok: true },
    ]);
    expect(native.writeFile.mock.calls.map((c) => c[0])).toEqual([
      "/repo/first",
      "/repo/third",
    ]);
    expect(usePlanStore.getState().queue).toEqual([]);
  });

  describe("same-file edits and stale versions", () => {
    const op = (old_string: string, new_string: string) => ({
      old_string,
      new_string,
    });
    const queued = (id: string, edits: ReturnType<typeof op>[]) =>
      edit({
        id,
        kind: "edit",
        edits,
        originalContent: "X0 Y0",
        proposedContent: "ignored by apply",
      });

    beforeEach(() => {
      native.readFile.mockResolvedValue({
        kind: "text",
        content: "X0 Y0",
        size: 5,
        version: "v1",
      });
      native.writeFile
        .mockResolvedValueOnce({ version: "v2" })
        .mockResolvedValueOnce({ version: "v3" });
    });

    it("lands two edits to one file by applying the second onto the first's result", async () => {
      const { enqueue, applyAll } = usePlanStore.getState();
      enqueue(queued("q-1", [op("X0", "X1")]));
      enqueue(queued("q-2", [op("Y0", "Y1")]));

      const results = await applyAll();

      expect(results).toEqual([
        { id: "q-1", ok: true },
        { id: "q-2", ok: true },
      ]);
      expect(native.writeFile.mock.calls).toEqual([
        ["/repo/a.ts", "X1 Y0", "v1"],
        ["/repo/a.ts", "X1 Y1", "v2"],
      ]);
    });

    it("reports every edit stale when the file changed after they were queued", async () => {
      native.readFile.mockResolvedValue({
        kind: "text",
        content: "X0 Y0 saved in the editor",
        size: 25,
        version: "v9",
      });
      const { enqueue, applyAll } = usePlanStore.getState();
      enqueue(queued("q-1", [op("X0", "X1")]));
      enqueue(queued("q-2", [op("Y0", "Y1")]));

      const results = await applyAll();

      expect(native.writeFile).not.toHaveBeenCalled();
      expect(results.map((r) => r.ok)).toEqual([false, false]);
      expect(results[0].error).toMatch(/changed on disk/);
      expect(usePlanStore.getState().queue.map((q) => q.id)).toEqual([
        "q-1",
        "q-2",
      ]);
    });

    it("reports a save that loses the race as stale and stops the file's chain", async () => {
      const { StaleFileError } = await import("@/modules/ai/lib/staleFile");
      native.writeFile
        .mockReset()
        .mockRejectedValueOnce(new StaleFileError("/repo/a.ts"));
      const { enqueue, applyAll } = usePlanStore.getState();
      enqueue(queued("q-1", [op("X0", "X1")]));
      enqueue(queued("q-2", [op("Y0", "Y1")]));

      const results = await applyAll();

      expect(native.writeFile).toHaveBeenCalledTimes(1);
      expect(results.map((r) => r.ok)).toEqual([false, false]);
      expect(results[0].error).toMatch(/changed on disk/);
    });

    it("reports a queued edit that no longer applies to the running buffer", async () => {
      const { enqueue, applyAll } = usePlanStore.getState();
      enqueue(queued("q-1", [op("X0", "X1")]));
      enqueue(queued("q-2", [op("X0", "X2")]));

      const results = await applyAll();

      expect(results[0]).toEqual({ id: "q-1", ok: true });
      expect(results[1]).toMatchObject({ id: "q-2", ok: false });
      expect(results[1].error).toMatch(/old_string not found/);
      expect(results[1].error).toMatch(/rejected and asked for again/);
    });

    it("creates a new file only if it still does not exist", async () => {
      native.readFile.mockResolvedValue({
        kind: "text",
        content: "someone made it",
        size: 15,
        version: "v7",
      });
      const { enqueue, applyAll } = usePlanStore.getState();
      enqueue(
        edit({
          kind: "write_file",
          isNewFile: true,
          baseVersion: null,
          path: "/repo/new.ts",
        }),
      );

      const results = await applyAll();

      expect(results[0].ok).toBe(false);
      expect(native.writeFile).not.toHaveBeenCalled();
    });
  });
});
