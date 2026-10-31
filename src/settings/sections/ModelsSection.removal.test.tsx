import type { ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  effects: [] as (() => unknown)[],
  watchKeys: vi.fn(),
  cells: [] as unknown[],
  index: 0,
  invoke: vi.fn(),
  changed: vi.fn(async () => {}),
  endpoints: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  retry: vi.fn(async () => {}),
  model: vi.fn(async () => {}),
  preferences: {} as Record<string, unknown>,
}));
vi.mock("react", async (original) => ({
  ...(await original<object>()),
  useState: (initial: unknown) => {
    const i = fake.index++;
    if (!(i in fake.cells)) fake.cells[i] = initial;
    return [
      fake.cells[i],
      (v: unknown) => {
        fake.cells[i] = typeof v === "function" ? v(fake.cells[i]) : v;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = fake.index++;
    if (!(i in fake.cells)) fake.cells[i] = { current: initial };
    return fake.cells[i];
  },
  useMemo: (create: () => unknown, deps: unknown[]) => {
    const i = fake.index++;
    const old = fake.cells[i] as
      | { value: unknown; deps: unknown[] }
      | undefined;
    const cell =
      !old || deps.some((v, n) => v !== old.deps[n])
        ? { value: create(), deps }
        : old;
    fake.cells[i] = cell;
    return cell.value;
  },
  useEffect: (fn: () => unknown) => fake.effects.push(fn),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("./endpointProbe", () => ({
  requestEndpointProbe: (baseUrl: string) =>
    fake.invoke("lm_ping", { baseUrl }),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: Object.assign(
    (select: (s: Record<string, unknown>) => unknown) =>
      select(fake.preferences),
    { getState: () => fake.preferences },
  ),
}));
vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: {
    getState: () => ({ selectedModelId: "", setSelectedModelId: vi.fn() }),
  },
}));
vi.mock("@/modules/settings/store", async (original) => ({
  ...(await original<object>()),
  emitKeysChanged: fake.changed,
  onKeysChanged: fake.watchKeys,
  setOpenrouterModelId: fake.model,
}));
vi.mock("@/modules/settings/endpoints", () => ({
  retryCustomEndpoints: fake.retry,
  createCustomEndpoint: vi.fn(),
  deleteCustomEndpoint: fake.endpoints,
  updateCustomEndpoint: fake.update,
  loadCustomEndpoints: vi.fn(async () => []),
  onCustomEndpoints: vi.fn(async () => () => {}),
}));

import { EMPTY_PROVIDER_KEYS } from "@/modules/ai/lib/keyring";
import { DEFAULT_PREFERENCES } from "@/modules/settings/store";
import { ModelsSection } from "./ModelsSection";

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function render() {
  fake.index = 0;
  return nodes(ModelsSection());
}
function provider(id: string) {
  const node = render().find(
    (n) => (n.props.provider as { id?: string })?.id === id,
  );
  if (!node) throw new Error(`Provider missing: ${id}`);
  return node;
}
beforeEach(() => {
  fake.cells = [
    "",
    { ...EMPTY_PROVIDER_KEYS, openai: "secret", openrouter: "secret" },
    { e1: { origin: "https://example.com", key: "secret" } },
    new Set(),
  ];
  fake.preferences = {
    ...DEFAULT_PREFERENCES,
    openrouterModelId: "vendor/model",
    customEndpoints: [
      {
        id: "e1",
        name: "Example",
        baseURL: "https://example.com",
        modelId: "model",
      },
    ],
  };
  fake.invoke.mockReset().mockRejectedValue("credential store locked");
  fake.changed.mockClear();
  fake.effects = [];
  fake.watchKeys.mockReset().mockResolvedValue(vi.fn());
  fake.endpoints.mockReset().mockResolvedValue(undefined);
  fake.update.mockClear();
  fake.retry.mockReset().mockResolvedValue(undefined);
  fake.model.mockClear();
});
it("failed provider removal shows an error and preserves the key and model for retry", async () => {
  for (const id of ["openai", "openrouter"]) {
    await (provider(id).props.onRemove as () => Promise<void>)();
    expect(provider(id)).toBeDefined();
    expect(
      render().find((n) => n.props.role === "alert")?.props.children,
    ).toContain("credential store locked");
  }
  expect(fake.changed).not.toHaveBeenCalled();
  expect(fake.model).not.toHaveBeenCalled();
  fake.invoke.mockResolvedValue(undefined);
  await (provider("openrouter").props.onRemove as () => Promise<void>)();
  expect(fake.model).toHaveBeenCalledWith("");
  expect(fake.changed).toHaveBeenCalledOnce();
  expect(render().find((n) => n.props.role === "alert")).toBeUndefined();
});
it("a failed native deletion preserves the displayed endpoint and key", async () => {
  fake.endpoints.mockRejectedValueOnce(new Error("credential store locked"));
  const endpoint = render().find(
    (n) => (n.props.endpoint as { id?: string })?.id === "e1",
  );
  if (!endpoint) throw new Error("Endpoint missing");
  await (endpoint.props.onRemove as () => Promise<void>)();
  expect(fake.endpoints).toHaveBeenCalledWith("e1");
  expect(fake.invoke).not.toHaveBeenCalled();
  expect(
    render().find((n) => n.props.role === "alert")?.props.children,
  ).toContain("credential store locked");
  expect(fake.cells[2]).toEqual({
    e1: { origin: "https://example.com", key: "secret" },
  });
});

it("Browse Models never receives the previous host's key from a changed URL draft", () => {
  const endpoint = render().find(
    (n) => (n.props.endpoint as { id?: string })?.id === "e1",
  );
  if (!endpoint) throw new Error("Endpoint missing");
  const card = endpoint.type as (
    props: Record<string, unknown>,
  ) => ReactElement;
  fake.cells = [];
  const renderCard = () => {
    fake.index = 0;
    return nodes(card(endpoint.props));
  };
  renderCard();
  fake.cells[0] = true; // Expand the card.
  let tree = renderCard();
  const browse = () => tree.find((n) => "apiKey" in n.props);
  expect(browse()?.props.apiKey).toBe("secret");
  const input = tree.find((n) => n.props.value === "https://example.com");
  if (!input) throw new Error("URL input missing");
  (input.props.onChange as (e: { target: { value: string } }) => void)({
    target: { value: "https://other.example/v1" },
  });
  tree = renderCard();
  expect(browse()?.props.baseURL).toBe("https://other.example/v1");
  expect(browse()?.props.apiKey).toBeNull();
  fake.cells[2] = "https://example.com/v2";
  tree = renderCard();
  expect(browse()?.props.apiKey).toBe("secret");
});

it("key saves send their requested URL to native validation without optimistic cache writes", async () => {
  const endpoint = render().find(
    (n) => (n.props.endpoint as { id?: string })?.id === "e1",
  );
  if (!endpoint) throw new Error("Endpoint missing");
  let finish!: () => void;
  fake.invoke.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const saving = (endpoint.props.onSaveKey as (key: string) => Promise<void>)(
    "new-secret",
  );
  fake.preferences.customEndpoints = [
    { id: "e1", baseURL: "https://other.example", modelId: "model" },
  ];
  finish();
  await saving;
  expect(fake.invoke).toHaveBeenCalledWith("ai_endpoint_credential", {
    change: {
      kind: "set",
      id: "e1",
      baseURL: "https://example.com",
      key: "new-secret",
    },
  });
  expect(fake.changed).not.toHaveBeenCalled();
  expect(fake.cells[2]).toEqual({
    e1: { origin: "https://example.com", key: "secret" },
  });
});

it("native key invalidation refreshes Settings even when endpoint deletion then fails", async () => {
  const endpoint = render().find(
    (n) => (n.props.endpoint as { id?: string })?.id === "e1",
  );
  if (!endpoint) throw new Error("Endpoint missing");
  let stored: string | null = JSON.stringify({
    format: "oarlock-endpoint-key-v1",
    origin: "https://example.com",
    key: "secret",
  });
  fake.invoke.mockImplementation(async () => [
    { status: "ready", value: stored },
  ]);
  const stop = fake.effects[0]() as () => void;
  await new Promise((r) => setTimeout(r, 0));
  fake.endpoints.mockImplementationOnce(async () => {
    stored = null;
    fake.watchKeys.mock.calls[0][0](); // Native head deletion is already committed.
    throw new Error("settings disk full");
  });
  await (endpoint.props.onRemove as () => Promise<void>)();
  await new Promise((r) => setTimeout(r, 0));
  expect(fake.changed).not.toHaveBeenCalled();
  expect(
    render().find((n) => n.props.role === "alert")?.props.children,
  ).toContain("settings disk full");
  expect(fake.cells[2]).toEqual({ e1: null });
  stop();
});

it("independent endpoint edits send only their own fields, never stale whole-list snapshots", async () => {
  const endpoint = render().find(
    (n) => (n.props.endpoint as { id?: string })?.id === "e1",
  );
  if (!endpoint) throw new Error("Endpoint missing");
  const update = endpoint.props.onUpdate as (
    patch: Record<string, string>,
  ) => Promise<void>;
  await Promise.all([
    update({ name: "Renamed" }),
    update({ modelId: "new-model" }),
  ]);
  expect(fake.update.mock.calls).toEqual([
    ["e1", { name: "Renamed" }],
    ["e1", { modelId: "new-model" }],
  ]);
});
it("deleting an endpoint does not submit a replacement list", async () => {
  fake.invoke.mockResolvedValue(undefined);
  const endpoint = render().find(
    (n) => (n.props.endpoint as { id?: string })?.id === "e1",
  );
  if (!endpoint) throw new Error("Endpoint missing");
  await (endpoint.props.onRemove as () => Promise<void>)();
  expect(fake.endpoints).toHaveBeenCalledWith("e1");
});

it("retries a damaged endpoint store and displays recovery errors", async () => {
  fake.preferences.customEndpointsError = "The endpoint file could not be read";
  fake.retry.mockRejectedValueOnce(new Error("still damaged"));
  const retry = render().find((n) => n.props.children === "Retry");
  if (!retry) throw new Error("Retry button missing");
  (retry.props.onClick as () => void)();
  await Promise.resolve();
  await Promise.resolve();
  expect(fake.retry).toHaveBeenCalledOnce();
  expect(
    render()
      .filter((n) => n.props.role === "alert")
      .some((n) => String(n.props.children).includes("still damaged")),
  ).toBe(true);
});

it.each(["x", "abcd", "abcdefgh"])(
  "does not expose the short custom-endpoint key %s in its masked preview",
  (key) => {
    fake.cells[2] = { e1: { origin: "https://example.com", key } };
    const endpoint = render().find(
      (n) => (n.props.endpoint as { id?: string })?.id === "e1",
    );
    if (!endpoint) throw new Error("Endpoint missing");
    // Mount the expanded card with isolated hook cells; keep the parent callback props.
    fake.cells = [true];
    fake.index = 0;
    const card = nodes(
      (endpoint.type as (props: Record<string, unknown>) => Node)(
        endpoint.props,
      ),
    );
    const preview = card.find((node) => node.type === "code")?.props.children;
    expect(preview).toBe("•".repeat(key.length));
  },
);

it("keeps failed provider and endpoint entries visible with recovery and replacement controls", () => {
  (fake.cells[1] as Record<string, unknown>).openai = {
    status: "failed",
    error: "locked",
  };
  fake.cells[2] = { e1: { status: "failed", error: "locked" } };
  const cloud = provider("openai");
  expect(cloud.props.currentKey).toBeNull();
  expect(cloud.props.credentialIssue).toContain("locked");
  expect(cloud.props.onRetryKey).toEqual(expect.any(Function));
  const endpoint = render().find(
    (n) => (n.props.endpoint as { id?: string })?.id === "e1",
  );
  if (!endpoint) throw new Error("Endpoint missing");
  expect(endpoint.props.credentialIssue).toContain("locked");
  fake.cells = [true];
  fake.index = 0;
  const card = nodes(
    (endpoint.type as (props: Record<string, unknown>) => Node)(endpoint.props),
  );
  const recovery = card.find((n) => typeof n.props.problem === "string");
  expect(recovery?.props.problem).toContain("locked");
  expect(recovery?.props.onRetry).toEqual(expect.any(Function));
  expect(recovery?.props.onRemove).toEqual(expect.any(Function));
  expect(card.some((n) => n.props.type === "password")).toBe(true);
  expect(
    card.find((n) => n.props.baseURL === "https://example.com")?.props.disabled,
  ).toBe(true);
});

it("can remove an unreadable stored key and reports deletion failure for retry", async () => {
  fake.cells[2] = { e1: { status: "failed", error: "locked" } };
  const endpoint = render().find(
    (n) => (n.props.endpoint as { id?: string })?.id === "e1",
  );
  if (!endpoint) throw new Error("Endpoint missing");
  await (endpoint.props.onClearKey as () => Promise<void>)();
  expect(fake.invoke).toHaveBeenCalledWith("ai_endpoint_credential", {
    change: { kind: "clear", id: "e1" },
  });
  expect(
    render().find((n) => n.props.role === "alert")?.props.children,
  ).toContain("locked");
  expect(fake.cells[2]).toEqual({ e1: { status: "failed", error: "locked" } });
});

it("Retry reconnects a failed listener and broadcasts recovery to chat windows", async () => {
  fake.watchKeys
    .mockRejectedValueOnce(new Error("listener unavailable"))
    .mockResolvedValue(vi.fn());
  render();
  const stop = fake.effects[0]() as () => void;
  await new Promise((r) => setTimeout(r, 0));
  const endpoint = render().find(
    (n) => (n.props.endpoint as { id?: string })?.id === "e1",
  );
  if (!endpoint) throw new Error("Endpoint missing");
  expect(endpoint.props.credentialIssue).toContain("listener unavailable");
  await (endpoint.props.onRetryKey as () => Promise<void>)();
  expect(fake.watchKeys).toHaveBeenCalledTimes(2);
  expect(fake.changed).toHaveBeenCalledOnce();
  fake.invoke.mockImplementation(async (_command, args) =>
    args.accounts.map(() => ({ status: "ready", value: null })),
  );
  fake.watchKeys.mock.calls[1][0]();
  await new Promise((r) => setTimeout(r, 0));
  expect(fake.cells[2]).toEqual({ e1: null });
  stop();
});

it("a delayed endpoint Test result cannot mark a changed URL as reachable", async () => {
  const endpoint = render().find(
    (n) => (n.props.endpoint as { id?: string })?.id === "e1",
  );
  if (!endpoint) throw new Error("Endpoint missing");
  const card = endpoint.type as (
    props: Record<string, unknown>,
  ) => ReactElement;
  fake.cells = [];
  const renderCard = () => {
    fake.index = 0;
    return nodes(card(endpoint.props));
  };
  renderCard();
  fake.cells[0] = true;
  let tree = renderCard();
  let complete!: (value: number) => void;
  fake.invoke.mockImplementation((command: string) =>
    command === "lm_ping"
      ? new Promise<number>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(),
  );
  const button = tree.find((n) => n.props.children === "Test");
  if (!button) throw new Error("Test button missing");
  const pending = (button.props.onClick as () => Promise<void>)();
  const input = tree.find((n) => n.props.value === "https://example.com");
  if (!input) throw new Error("URL input missing");
  (input.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "https://other.example/v1" },
  });
  tree = renderCard();
  complete(200);
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = renderCard();
  const status = tree.find(
    (n) => n.props.state && typeof n.props.state === "object",
  );
  expect(status?.props.state).toEqual({ status: "idle" });
});
