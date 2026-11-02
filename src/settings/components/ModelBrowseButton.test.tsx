import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const fake = vi.hoisted(() => ({
  cells: [] as unknown[],
  index: 0,
  effects: [] as (() => void)[],
  list: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<object>()),
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
  useRef: (initial: unknown) => {
    const i = fake.index++;
    fake.cells[i] ??= { current: initial };
    return fake.cells[i];
  },
  useMemo: (create: () => unknown, deps: unknown[]) => {
    const i = fake.index++;
    const old = fake.cells[i] as MemoCell | undefined;
    const cell =
      !old || deps.some((v, n) => v !== old.deps[n])
        ? { deps, value: create() }
        : old;
    fake.cells[i] = cell;
    return cell.value;
  },
  useEffect: (create: () => (() => void) | undefined, deps: unknown[]) => {
    const i = fake.index++;
    const old = fake.cells[i] as EffectCell | undefined;
    if (!old || deps.some((v, n) => v !== old.deps[n])) {
      const cell: EffectCell = { deps };
      fake.cells[i] = cell;
      fake.effects.push(() => {
        old?.cleanup?.();
        cell.cleanup = create();
      });
    }
  },
}));
vi.mock("@/modules/ai/lib/endpointModels", () => ({
  listEndpointModels: fake.list,
}));
import { ModelBrowseButton } from "./ModelBrowseButton";

type Node = ReactElement<Record<string, unknown>>;
type MemoCell = { deps: unknown[]; value: unknown };
type EffectCell = { deps: unknown[]; cleanup?: (() => void) | undefined };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const select = vi.fn();
let props: Parameters<typeof ModelBrowseButton>[0];
function render() {
  fake.index = 0;
  const result = nodes(ModelBrowseButton(props));
  for (const effect of fake.effects.splice(0)) effect();
  return result;
}
function open() {
  (render()[0].props.onOpenChange as (open: boolean) => void)(true);
}
function items() {
  return render().filter((n) => n.props.onSelect);
}
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}
beforeEach(() => {
  fake.cells = [];
  fake.effects = [];
  fake.list.mockReset();
  select.mockClear();
  props = {
    baseURL: "https://one.example/v1",
    apiKey: "first",
    onSelect: select,
  };
});
it.each(["url", "key", "disabled"])(
  "invalidates ready models when %s changes",
  async (change) => {
    fake.list.mockResolvedValue(["old-model"]);
    open();
    await flush();
    expect(items()).toHaveLength(1);
    if (change === "url")
      props = { ...props, baseURL: "https://two.example/v1" };
    if (change === "key") props = { ...props, apiKey: "second" };
    if (change === "disabled") props = { ...props, disabled: true };
    expect(items()).toHaveLength(0);
    if (change !== "disabled") {
      open();
      expect(fake.list).toHaveBeenCalledTimes(2);
    }
  },
);
it("aborts obsolete requests and rejects their late results", async () => {
  let finish!: (ids: string[]) => void;
  fake.list.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  open();
  const signal = fake.list.mock.calls[0][3] as AbortSignal;
  props = { ...props, disabled: true };
  render();
  expect(signal?.aborted).toBe(true);
  finish(["old-model"]);
  await flush();
  expect(items()).toHaveLength(0);
  props = { ...props, disabled: false };
  render();
  expect(items()).toHaveLength(0);
});
it("reuses ready models only for unchanged credentials and URL", async () => {
  fake.list.mockResolvedValue(["model"]);
  open();
  await flush();
  open();
  expect(fake.list).toHaveBeenCalledOnce();
  (items()[0].props.onSelect as () => void)();
  expect(select).toHaveBeenCalledWith("model");
});
it("aborts the request when the browser unmounts", () => {
  fake.list.mockReturnValue(new Promise(() => {}));
  open();
  const signal = fake.list.mock.calls[0][3] as AbortSignal;
  for (const cell of fake.cells) (cell as EffectCell | undefined)?.cleanup?.();
  expect(signal?.aborted).toBe(true);
});

it("a refresh supersedes an older request even if that server ignores abort", async () => {
  let first!: (models: string[]) => void;
  fake.list
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          first = r;
        }),
    )
    .mockResolvedValueOnce(["new-model"]);
  open();
  const signal = fake.list.mock.calls[0][3] as AbortSignal;
  open();
  await flush();
  expect(signal.aborted).toBe(true);
  first(["old-model"]);
  await flush();
  expect(items().map((item) => item.props.children)).toEqual(["new-model"]);
});

it("cleanup of the old context does not abort a new context's request", async () => {
  fake.list.mockReturnValue(new Promise(() => {}));
  open();
  const oldSignal = fake.list.mock.calls[0][3] as AbortSignal;
  props = { ...props, apiKey: "replacement" };
  fake.index = 0;
  // Invoke the committed new handler before passive cleanup of the old effect.
  const next = nodes(ModelBrowseButton(props));
  (next[0].props.onOpenChange as (open: boolean) => void)(true);
  const nextSignal = fake.list.mock.calls[1][3] as AbortSignal;
  for (const effect of fake.effects.splice(0)) effect();
  expect(oldSignal.aborted).toBe(true);
  expect(nextSignal.aborted).toBe(false);
});
