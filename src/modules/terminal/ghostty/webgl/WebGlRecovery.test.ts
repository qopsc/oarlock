import type { GhosttyTerminalModelApi } from "@/modules/terminal/ghostty/GhosttyTerminalModel";
import { afterEach, expect, it, vi } from "vitest";

const emptyCells = {
  length: 1,
  width: () => 1,
  flags: () => 0,
  codepoint: () => 0,
  graphemeLength: () => 0,
  backgroundPacked: () => 0,
  foregroundPacked: () => 0xffffff,
  underlineColorPacked: () => 0,
  underlineStyle: () => 0,
  overline: () => false,
};

function harness() {
  const methods = new Map<string, ReturnType<typeof vi.fn>>();
  const gl = new Proxy(
    {},
    {
      get: (_, key: string) => {
        if (/^[A-Z_0-9]+$/.test(key)) return 1;
        let method = methods.get(key);
        if (!method) {
          method = vi.fn(() => (key === "getExtension" ? null : {}));
          methods.set(key, method);
        }
        return method;
      },
    },
  );
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("document", {
    createElement: () =>
      Object.assign(new EventTarget(), {
        width: 1,
        height: 1,
        style: {},
        setAttribute() {},
        remove() {},
        getContext: (kind: string) => (kind === "webgl2" ? gl : {}),
      }),
  });
  return { methods };
}

const profile = {
  metrics: {
    scale: 1,
    deviceCellWidth: 8,
    deviceCellHeight: 16,
    deviceBaseline: 12,
    cellWidth: 8,
    cellHeight: 16,
    baseline: 12,
    font: {
      family: "monospace",
      size: 14,
      weight: "400",
      lineHeight: 1.2,
      letterSpacing: 0,
    },
  },
  theme: {
    background: [0, 0, 0] as [number, number, number],
    foreground: [255, 255, 255] as [number, number, number],
    cursor: [255, 255, 255] as [number, number, number],
    selection: { color: [50, 50, 50] as [number, number, number], alpha: 0.5 },
    palette: [],
  },
  scale: 1,
};

function frame() {
  const model = {
    cols: 1,
    rows: 1,
    cursor: () => ({
      x: 0,
      y: 0,
      visible: false,
      blinking: false,
      style: "block",
    }),
    viewportOriginLine: () => 0,
    renderCells: () => emptyCells,
    imagePlacements: () => [{ imageId: 1, z: 0 }],
  } as unknown as GhosttyTerminalModelApi;
  return {
    model,
    damage: { kind: "full" as const },
    cursorVisible: true,
    textBlinkVisible: true,
    selection: null,
    searchMatchAt: () => 0 as const,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("reports an image-module load failure and retries the next renderer", async () => {
  harness();
  const { WebGlCellRenderer } = await import("./WebGlCellRenderer");
  const loader = vi
    .fn()
    .mockRejectedValueOnce(new Error("image module failed"))
    .mockResolvedValueOnce({ WebGlImageLayer: class {} });
  const failure = vi.fn();
  const first = new WebGlCellRenderer(false, loader);
  first.configure(profile, () => {}, failure);
  first.resize(1, 1);
  first.render(frame());
  await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
  expect(failure.mock.calls[0][0].message).toContain("image module failed");
  first.dispose();

  const next = new WebGlCellRenderer(false, loader);
  try {
    next.configure(profile, () => {}, vi.fn());
    next.resize(1, 1);
    next.render(frame());
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  } finally {
    next.dispose();
  }
});

it("reports resource creation failures during context restoration", async () => {
  const { methods } = harness();
  const { WebGlCellRenderer } = await import("./WebGlCellRenderer");
  const failure = vi.fn();
  const renderer = new WebGlCellRenderer();
  try {
    renderer.configure(profile, () => {}, failure);
    renderer.resize(1, 1);
    renderer.canvas.dispatchEvent(
      new Event("webglcontextlost", { cancelable: true }),
    );
    methods.get("createBuffer")?.mockReturnValueOnce(null);
    expect(() =>
      renderer.canvas.dispatchEvent(new Event("webglcontextrestored")),
    ).not.toThrow();
    expect(failure).toHaveBeenCalledOnce();
    expect(renderer.render(frame())).toBe(false);
  } finally {
    renderer.dispose();
  }
});

it("does not report an obsolete image request to a new renderer owner", async () => {
  harness();
  const { WebGlCellRenderer } = await import("./WebGlCellRenderer");
  let rejectLoad: (error: Error) => void = () => {};
  const loader = vi.fn(
    () =>
      new Promise<typeof import("./WebGlImageLayer")>((_, reject) => {
        rejectLoad = reject;
      }),
  );
  const firstFailure = vi.fn();
  const nextFailure = vi.fn();
  const renderer = new WebGlCellRenderer(false, loader);
  try {
    renderer.configure(profile, () => {}, firstFailure);
    renderer.resize(1, 1);
    renderer.render(frame());
    renderer.detach();
    renderer.configure(profile, () => {}, nextFailure);
    rejectLoad(new Error("obsolete image request"));
    await Promise.resolve();
    await Promise.resolve();
    expect(firstFailure).not.toHaveBeenCalled();
    expect(nextFailure).not.toHaveBeenCalled();
  } finally {
    renderer.dispose();
  }
});
