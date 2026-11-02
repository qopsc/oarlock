import { afterEach, expect, it, vi } from "vitest";
import type { GhosttyTerminalModelApi } from "../GhosttyTerminalModel";
import { GhosttySearchController } from "./GhosttySearchController";

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const ports: Worker[] = [];
  vi.stubGlobal(
    "Worker",
    class {
      onmessage = null;
      onerror = null;
      onmessageerror = null;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() {
        ports.push(this as unknown as Worker);
      }
    },
  );
  const model = {
    rows: 1,
    cols: 1,
    clearSearch: vi.fn(),
    revision: () => 1,
    scrollPosition: () => ({ history: 0 }),
    readCellLine: () => ["x"],
    viewportOriginLine: () => 0,
  } as unknown as GhosttyTerminalModelApi;
  let id = 0;
  const frames = new Map<number, () => void>();
  const controller = new GhosttySearchController(model, vi.fn(), {
    request: (callback) => {
      frames.set(++id, callback);
      return id;
    },
    cancel: (id) => {
      frames.delete(id);
    },
  });
  const flush = () => {
    for (const [id, callback] of frames) {
      frames.delete(id);
      callback();
    }
  };
  return { controller, ports, flush, frames, model };
}

it("publishes an actionable failure and restarts only on explicit Retry", async () => {
  const f = fixture();
  try {
    f.controller.findNext("x", { regex: true, incremental: true });
    expect(f.frames.size).toBe(0);
    f.ports[0].onmessage?.call(f.ports[0], {
      data: { id: 1, error: "Regex search timed out" },
    } as MessageEvent);
    await Promise.resolve();
    f.flush();
    expect(f.controller.matchCount()).toMatchObject({
      error: "Regex search timed out",
      total: 0,
      pending: false,
    });
    f.controller.invalidate();
    f.flush();
    f.controller.findNext("x", { regex: true, incremental: true });
    expect(f.ports).toHaveLength(1);
    f.controller.findNext("x", { regex: true });
    expect(f.ports).toHaveLength(2);
    f.ports[1].onmessage?.call(f.ports[1], {
      data: { id: 1, matches: [{ line: 0, startColumn: 0, endColumn: 1 }] },
    } as MessageEvent);
    await Promise.resolve();
    f.flush();
    expect(f.controller.matchCount()).toEqual({
      current: 1,
      total: 1,
      capped: false,
      pending: false,
    });
    expect(f.ports[1].terminate).toHaveBeenCalledOnce();
  } finally {
    f.controller.dispose();
  }
});
it("preserves a regex failure during renderer replacement", async () => {
  const f = fixture();
  try {
    f.controller.findNext("x", { regex: true });
    f.ports[0].onmessage?.call(f.ports[0], {
      data: { id: 1, error: "Invalid regex" },
    } as MessageEvent);
    await Promise.resolve();
    f.flush();
    f.controller.restore(f.controller.snapshot());
    expect(f.ports).toHaveLength(1);
    expect(f.controller.matchCount()?.error).toBe("Invalid regex");
  } finally {
    f.controller.dispose();
  }
});
it.each(["suspend", "clearDecorations", "dispose"] as const)(
  "%s retires the worker and ignores queued replies",
  async (action) => {
    const f = fixture();
    f.controller.findNext("x", { regex: true });
    const reply = f.ports[0].onmessage;
    if (!reply) throw new Error("Missing worker reply handler");
    f.controller[action]();
    reply.call(f.ports[0], {
      data: { id: 1, matches: [{ line: 0, startColumn: 0, endColumn: 1 }] },
    } as MessageEvent);
    await Promise.resolve();
    expect(f.frames.size).toBe(0);
    expect(f.ports[0].terminate).toHaveBeenCalledOnce();
    f.controller.dispose();
  },
);
