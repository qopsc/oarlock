import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  cells: [] as unknown[],
  index: 0,
  effects: [] as (() => void)[],
  deps: new Map<number, { deps: unknown[]; cleanup?: () => void }>(),
  cleanups: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<object>()),
  forwardRef:
    (fn: (props: unknown, ref: null) => unknown) => (props: unknown) =>
      fn(props, null),
  useState: (initial: unknown) => {
    const i = hooks.index++;
    if (!(i in hooks.cells)) hooks.cells[i] = initial;
    return [
      hooks.cells[i],
      (value: unknown) => {
        hooks.cells[i] =
          typeof value === "function" ? value(hooks.cells[i]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = hooks.index++;
    hooks.cells[i] ??= { current: initial };
    return hooks.cells[i];
  },
  useImperativeHandle: () => {},
  useEffect: effect,
  useLayoutEffect: effect,
}));
function effect(fn: () => undefined | (() => void), deps: unknown[]) {
  const i = hooks.index++,
    old = hooks.deps.get(i);
  if (!old || deps.some((d, j) => !Object.is(d, old.deps[j]))) {
    hooks.effects.push(() => {
      old?.cleanup?.();
      const cleanup = fn();
      hooks.deps.set(i, { deps, cleanup: cleanup || undefined });
    });
  }
}
function unmount() {
  for (const entry of hooks.deps.values()) entry.cleanup?.();
  hooks.deps.clear();
}
vi.mock("@/components/ui/button", () => ({ Button: "button" }));
vi.mock("@/components/ui/input", () => ({ Input: "input" }));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: "menu",
  DropdownMenuContent: "menu-content",
  DropdownMenuItem: "menu-item",
  DropdownMenuTrigger: "menu-trigger",
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { PreviewAddressBar } from "./PreviewAddressBar";

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const onSubmit = vi.fn();
function render(
  url = "http://localhost:3000",
  visible = true,
  navigationKey = 0,
) {
  hooks.index = 0;
  const tree = (PreviewAddressBar as unknown as (p: unknown) => unknown)({
    url,
    visible,
    navigationKey,
    onSubmit,
    onReload: vi.fn(),
  });
  for (const effect of hooks.effects.splice(0)) effect();
  return nodes(tree);
}
let resolve: (r: Response) => void;
beforeEach(() => {
  hooks.cells = [];
  hooks.effects = [];
  hooks.cleanups = [];
  hooks.deps.clear();
  onSubmit.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});
function act(tree: Node[], target: string, name: string, event: unknown) {
  const node = tree.find((n) => n.key === target || n.type === target);
  const action = node?.props[name];
  if (typeof action !== "function") throw Error(`Missing ${target}.${name}`);
  action(event);
}
const choose = (tree: Node[], port = "5173") =>
  act(tree, port, "onSelect", { preventDefault() {} });
function signal() {
  const value = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
  if (!value) throw Error("Missing fetch signal");
  return value;
}
it("a pending port check cannot replace a manually submitted URL", async () => {
  let tree = render();
  choose(tree);
  act(tree, "input", "onChange", {
    target: { value: "http://localhost:8000" },
  });
  tree = render();
  act(tree, "input", "onKeyDown", { key: "Enter", preventDefault() {} });
  expect(onSubmit).toHaveBeenCalledWith("http://localhost:8000");
  resolve(new Response());
  await new Promise((done) => setTimeout(done, 0));
  expect(onSubmit.mock.calls).toEqual([["http://localhost:8000"]]);
});
it("closing the address bar aborts its pending port request", () => {
  choose(render());
  const pending = signal();
  unmount();
  expect(pending.aborted).toBe(true);
});
it.each(["hidden", "url", "reload"])(
  "%s invalidates a pending preview check",
  async (kind) => {
    choose(render());
    const pending = signal();
    render(
      kind === "url" ? "http://localhost:8000" : "http://localhost:3000",
      kind !== "hidden",
      kind === "reload" ? 1 : 0,
    );
    expect(pending.aborted).toBe(true);
    resolve(new Response());
    await new Promise((done) => setTimeout(done, 0));
    expect(onSubmit).not.toHaveBeenCalled();
  },
);
it("a newer port check owns the result even if the old fetch ignores abort", async () => {
  choose(render());
  const old = resolve;
  choose(render(), "8000");
  const latest = resolve;
  old(new Response());
  await new Promise((done) => setTimeout(done, 0));
  expect(onSubmit).not.toHaveBeenCalled();
  latest(new Response());
  await new Promise((done) => setTimeout(done, 0));
  expect(onSubmit.mock.calls).toEqual([["http://localhost:8000"]]);
});
it("a hidden preview cannot admit new checks", () => {
  choose(render("http://localhost:3000", false));
  expect(fetch).not.toHaveBeenCalled();
});

it("typing cancels a check without requiring submission", async () => {
  const tree = render();
  choose(tree);
  const pending = signal();
  act(tree, "input", "onChange", {
    target: { value: "http://localhost:9000" },
  });
  expect(pending.aborted).toBe(true);
  resolve(new Response());
  await new Promise((done) => setTimeout(done, 0));
  expect(onSubmit).not.toHaveBeenCalled();
});
