import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  cells: [] as unknown[],
  index: 0,
  effects: [] as (() => void)[],
  invoke: vi.fn(),
  writes: 0,
}));
vi.mock("./endpointProbe", () => ({
  requestEndpointProbe: (baseUrl: string, signal: AbortSignal) => {
    signal.addEventListener(
      "abort",
      () => {
        void fake.invoke("lm_ping_cancel");
      },
      { once: true },
    );
    return fake.invoke("lm_ping", { baseUrl });
  },
}));
vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const i = fake.index++;
    fake.cells[i] ??= { current: initial };
    return fake.cells[i];
  },
  useState: (initial: unknown) => {
    const i = fake.index++;
    if (!(i in fake.cells)) fake.cells[i] = initial;
    return [
      fake.cells[i],
      (value: unknown) => {
        fake.cells[i] = value;
        fake.writes++;
      },
    ];
  },
  useMemo: (create: () => unknown, deps: unknown[]) => {
    const i = fake.index++;
    const old = fake.cells[i] as
      | { deps: unknown[]; value: unknown }
      | undefined;
    if (!old || deps.some((value, n) => value !== old.deps[n]))
      fake.cells[i] = { deps, value: create() };
    return (fake.cells[i] as { value: unknown }).value;
  },
  useEffect: (create: () => () => void, deps: unknown[]) => {
    const i = fake.index++;
    const old = fake.cells[i] as
      | { deps: unknown[]; cleanup?: () => void }
      | undefined;
    if (!old || deps.some((value, n) => value !== old.deps[n])) {
      const cell = { deps, cleanup: undefined as (() => void) | undefined };
      fake.cells[i] = cell;
      fake.effects.push(() => {
        old?.cleanup?.();
        cell.cleanup = create();
      });
    }
  },
}));

import { useEndpointPing } from "./endpointPing";

function Render(
  input: string | { url: string; enabled: boolean } = "https://a.test",
) {
  const { url, enabled } =
    typeof input === "string" ? { url: input, enabled: true } : input;
  fake.index = 0;
  const result = useEndpointPing(url, enabled);
  for (const effect of fake.effects.splice(0)) effect();
  return result;
}
beforeEach(() => {
  fake.cells = [];
  fake.index = 0;
  fake.effects = [];
  fake.writes = 0;
  fake.invoke.mockReset();
});
it("changing away and back cannot adopt an earlier test result", async () => {
  let complete!: (status: number) => void;
  fake.invoke.mockImplementation((command: string) =>
    command === "lm_ping"
      ? new Promise<number>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(),
  );
  const pending = Render().test();
  expect(Render().testStatus.status).toBe("testing");
  expect(Render("https://b.test").testStatus.status).toBe("idle");
  Render();
  complete(200);
  await pending;
  expect(Render().testStatus.status).toBe("idle");
});
it("only the latest test for an unchanged URL may report a result", async () => {
  const completions: ((status: number) => void)[] = [];
  fake.invoke.mockImplementation((command: string) =>
    command === "lm_ping"
      ? new Promise<number>((resolve) => {
          completions.push(resolve);
        })
      : Promise.resolve(),
  );
  const older = Render().test();
  const newer = Render().test();
  expect(
    fake.invoke.mock.calls.filter(([command]) => command === "lm_ping_cancel"),
  ).toHaveLength(1);
  completions[1](200);
  await newer;
  completions[0](0);
  await older;
  expect(Render().testStatus.status).toBe("ok");
});
it("completion after unmount does not update state", async () => {
  let complete!: (status: number) => void;
  fake.invoke.mockImplementation((command: string) =>
    command === "lm_ping"
      ? new Promise<number>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(),
  );
  const pending = Render().test();
  for (const cell of fake.cells)
    (cell as { cleanup?: () => void } | null)?.cleanup?.();
  const writes = fake.writes;
  complete(200);
  await pending;
  expect(fake.writes).toBe(writes);
});

it("unmount cancels the native connection probe", async () => {
  let complete!: (status: number) => void;
  fake.invoke.mockImplementation((command: string) =>
    command === "lm_ping"
      ? new Promise<number>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(),
  );
  const pending = Render().test();
  for (const cell of fake.cells)
    (cell as { cleanup?: () => void } | null)?.cleanup?.();
  const cancelled = fake.invoke.mock.calls.some(
    ([command]) => command === "lm_ping_cancel",
  );
  complete(200);
  await pending;
  expect(cancelled).toBe(true);
});

it("collapsing a card cancels its probe and prevents hidden tests", async () => {
  let complete!: (status: number) => void;
  fake.invoke.mockImplementation((command: string) =>
    command === "lm_ping"
      ? new Promise<number>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(),
  );
  const pending = Render().test();
  const collapsed = Render({ url: "https://a.test", enabled: false });
  expect(collapsed.testStatus.status).toBe("idle");
  expect(
    fake.invoke.mock.calls.filter(([command]) => command === "lm_ping_cancel"),
  ).toHaveLength(1);
  await collapsed.test();
  expect(
    fake.invoke.mock.calls.filter(([command]) => command === "lm_ping"),
  ).toHaveLength(1);
  complete(200);
  await pending;
  expect(Render().testStatus.status).toBe("idle");
});
