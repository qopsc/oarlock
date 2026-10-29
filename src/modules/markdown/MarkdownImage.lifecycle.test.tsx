import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Effect = { deps: unknown[]; cleanup?: () => void };
type Memo = { deps: unknown[]; value: unknown };
const fake = vi.hoisted(() => ({
  cells: [] as unknown[],
  index: 0,
  visible: true,
  effects: [] as (() => void)[],
  requests: [] as {
    url: string;
    resolve: (url: string) => void;
    reject: (error: Error) => void;
    release: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("@/modules/workspace", () => ({ useWorkspaceAssetUrl: () => null }));
vi.mock("./remoteImages", () => ({
  remoteImages: {
    acquire(url: string) {
      let resolve!: (url: string) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<string>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const release = vi.fn();
      fake.requests.push({ url, resolve, reject, release });
      return { url: promise, release };
    },
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<object>()),
  useContext: () => fake.visible,
  useState: (initial: unknown) => {
    const i = fake.index++;
    if (!(i in fake.cells)) fake.cells[i] = initial;
    return [
      fake.cells[i],
      (value: unknown) => {
        fake.cells[i] = value;
      },
    ];
  },
  useMemo: (create: () => unknown, deps: unknown[]) => {
    const i = fake.index++;
    const old = fake.cells[i] as Memo | undefined;
    const cell =
      !old || deps.some((value, n) => value !== old.deps[n])
        ? { deps, value: create() }
        : old;
    fake.cells[i] = cell;
    return cell.value;
  },
  useEffect: (create: () => (() => void) | undefined, deps: unknown[]) => {
    const i = fake.index++;
    const old = fake.cells[i] as Effect | undefined;
    if (!old || deps.some((value, n) => value !== old.deps[n])) {
      const cell: Effect = { deps };
      fake.cells[i] = cell;
      fake.effects.push(() => {
        old?.cleanup?.();
        cell.cleanup = create();
      });
    }
  },
}));

import { MarkdownImage } from "./MarkdownImage";

function render(src = "https://x/a") {
  fake.index = 0;
  const element = MarkdownImage({ src, alt: "preview" });
  for (const effect of fake.effects.splice(0)) effect();
  return element as ReactElement<{ src?: string }> | null;
}
function unmount() {
  for (const cell of fake.cells) {
    const effect = cell as Effect | null;
    effect?.cleanup?.();
    if (effect?.cleanup) effect.cleanup = undefined;
  }
}
beforeEach(() => {
  fake.cells = [];
  fake.effects = [];
  fake.requests = [];
  fake.index = 0;
  fake.visible = true;
});
afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

it("releases hidden previews and never shows an old object URL on return", async () => {
  expect(render()).toBeNull();
  fake.requests[0].resolve("blob:first");
  await Promise.resolve();
  expect(render()?.props.src).toBe("blob:first");
  fake.visible = false;
  expect(render()).toBeNull();
  expect(fake.requests[0].release).toHaveBeenCalledOnce();
  fake.visible = true;
  expect(render()).toBeNull();
  expect(fake.requests).toHaveLength(2);
  fake.requests[1].resolve("blob:second");
  await Promise.resolve();
  expect(render()?.props.src).toBe("blob:second");
});

it("ignores late completion after changing documents and releases the current lease on close", async () => {
  render("https://x/a");
  render("https://x/b");
  expect(fake.requests[0].release).toHaveBeenCalledOnce();
  fake.requests[0].resolve("blob:old");
  await Promise.resolve();
  expect(render("https://x/b")).toBeNull();
  fake.requests[1].resolve("blob:new");
  await Promise.resolve();
  expect(render("https://x/b")?.props.src).toBe("blob:new");
  unmount();
  expect(fake.requests[1].release).toHaveBeenCalledOnce();
});

it("does not acquire hidden images and does not report cancellation after close", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  fake.visible = false;
  render();
  expect(fake.requests).toHaveLength(0);
  fake.visible = true;
  render();
  unmount();
  fake.requests[0].reject(new DOMException("cancelled", "AbortError"));
  await Promise.resolve();
  expect(warn).not.toHaveBeenCalled();
});
