import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  effects: [] as (() => unknown)[],
  keysLoaded: false,
  apiKeys: {} as Record<string, unknown>,
  preferencesChanged: null as null | (() => void),
  prefs: {
    hydrated: true,
    customEndpoints: [] as {
      id: string;
      baseURL: string;
      modelId: string;
      name: string;
      contextLimit: number;
    }[],
  },
  subscribe: vi.fn(),
  read: vi.fn(),
  readEndpoints: vi.fn(async () => ({})),
  setKeys: vi.fn(),
  setEndpoints: vi.fn(),
  error: vi.fn(),
}));
vi.mock("react", () => ({
  useEffect: (fn: () => unknown) => fake.effects.push(fn),
  useState: () => [fake.keysLoaded, vi.fn()],
}));
vi.mock("sonner", () => ({ toast: { error: fake.error } }));
vi.mock("@/modules/agents/lib/review", () => ({
  firePendingReviewForSession: vi.fn(),
}));
vi.mock("@/modules/settings/store", () => ({ onKeysChanged: fake.subscribe }));
vi.mock("@/modules/settings/preferences", () => {
  const prefs = new Proxy(fake.prefs, {
    get: (target, key) => Reflect.get(target, key) ?? "",
  });
  return {
    usePreferencesStore: Object.assign(
      (select: (s: object) => unknown) => select(prefs),
      {
        getState: () => prefs,
        subscribe: (cb: () => void) => {
          fake.preferencesChanged = cb;
          return () => {
            fake.preferencesChanged = null;
          };
        },
      },
    ),
  };
});
vi.mock("../store/chatStore", () => ({
  useChatStore: (select: (s: object) => unknown) =>
    select({
      apiKeys: fake.apiKeys,
      setApiKeys: fake.setKeys,
      setCustomEndpointKeys: fake.setEndpoints,
    }),
}));
vi.mock("../store/agentsStore", () => ({ useAgentsStore: {} }));
vi.mock("../store/snippetsStore", () => ({ useSnippetsStore: {} }));
vi.mock("../lib/keyring", async (original) => ({
  ...(await original<object>()),
  getAllKeys: fake.read,
  getAllCustomEndpointKeys: fake.readEndpoints,
  hasAnyKey: () => false,
}));
import { useAiBootstrap } from "./useAiBootstrap";
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}
function start() {
  // biome-ignore lint/correctness/useHookAtTopLevel: Deterministic effect harness for subscription/read ordering.
  useAiBootstrap();
  return fake.effects[1]() as () => void;
}
beforeEach(() => {
  fake.effects = [];
  fake.keysLoaded = false;
  fake.apiKeys = {};
  fake.preferencesChanged = null;
  fake.prefs.customEndpoints = [];
  fake.readEndpoints.mockReset().mockResolvedValue({});
  fake.subscribe.mockReset();
  fake.read.mockReset();
  fake.setKeys.mockClear();
  fake.setEndpoints.mockClear();
  fake.error.mockClear();
});
it("cannot miss a key deletion while its cross-window listener is being registered", async () => {
  const registration = deferred<() => void>();
  fake.subscribe.mockReturnValue(registration.promise);
  let key: string | null = "old-secret";
  fake.read.mockImplementation(async () => ({ openai: key }));
  const stop = start();
  await flush();
  key = null; // Deleted in another window before this listener is ready: no event arrives here.
  registration.resolve(vi.fn());
  await flush();
  expect(fake.setKeys).toHaveBeenLastCalledWith({ openai: null });
  stop();
});
it("unmounting during registration removes the late listener without loading keys", async () => {
  const registration = deferred<() => void>();
  fake.subscribe.mockReturnValue(registration.promise);
  fake.read.mockResolvedValue({});
  const stop = start();
  stop();
  const unsubscribe = vi.fn();
  registration.resolve(unsubscribe);
  await flush();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(fake.setKeys).toHaveBeenLastCalledWith(
    expect.objectContaining({ openai: { status: "loading" } }),
  );
});
it("reports listener registration failure without treating a stale snapshot as current", async () => {
  fake.subscribe.mockRejectedValue(new Error("event bridge unavailable"));
  const stop = start();
  await flush();
  expect(fake.error).toHaveBeenCalledWith(
    "Could not watch API key changes",
    expect.objectContaining({
      description: expect.stringContaining("event bridge unavailable"),
    }),
  );
  expect(fake.read).not.toHaveBeenCalled();
  stop();
  await flush();
});
it("a deletion event wins over an earlier credential read that finishes later", async () => {
  const old = deferred<object>();
  fake.subscribe.mockResolvedValue(vi.fn());
  fake.read
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue({ openai: null });
  const stop = start();
  await flush();
  fake.subscribe.mock.calls[0][0]();
  await flush();
  old.resolve({ openai: "deleted-secret" });
  await flush();
  expect(fake.setKeys).toHaveBeenLastCalledWith({ openai: null });
  expect(fake.setKeys).not.toHaveBeenCalledWith({ openai: "deleted-secret" });
  stop();
});

it("loads keys when Retry restores endpoints without a credential-change event", async () => {
  fake.subscribe.mockResolvedValue(vi.fn());
  fake.read.mockResolvedValue({});
  const stop = start();
  await flush();
  fake.readEndpoints.mockResolvedValue({
    restored: { origin: "https://example.com", key: "saved" },
  });
  fake.prefs.customEndpoints = [
    {
      id: "restored",
      baseURL: "https://example.com",
      modelId: "m",
      name: "Restored",
      contextLimit: 128000,
    },
  ];
  fake.preferencesChanged?.();
  await flush();
  expect(fake.setEndpoints).toHaveBeenLastCalledWith({
    restored: { origin: "https://example.com", key: "saved" },
  });
  expect(fake.read).toHaveBeenCalledOnce();
  const reads = fake.readEndpoints.mock.calls.length;
  fake.prefs.customEndpoints = [
    { ...fake.prefs.customEndpoints[0], name: "Renamed" },
  ];
  fake.preferencesChanged?.();
  await flush();
  expect(fake.readEndpoints).toHaveBeenCalledTimes(reads);
  stop();
  expect(fake.preferencesChanged).toBeNull();
});

it("deletion invalidates a delayed endpoint read without reloading provider keys", async () => {
  fake.subscribe.mockResolvedValue(vi.fn());
  fake.read.mockResolvedValue({});
  fake.prefs.customEndpoints = [
    {
      id: "gone",
      baseURL: "https://example.com",
      modelId: "m",
      name: "Gone",
      contextLimit: 128000,
    },
  ];
  const old = deferred<object>();
  fake.readEndpoints.mockReturnValueOnce(old.promise).mockResolvedValue({});
  const stop = start();
  await flush();
  fake.prefs.customEndpoints = [];
  fake.preferencesChanged?.();
  await flush();
  old.resolve({ gone: { origin: "https://example.com", key: "deleted" } });
  await flush();
  expect(fake.setEndpoints).toHaveBeenLastCalledWith({});
  expect(fake.setEndpoints).not.toHaveBeenCalledWith({
    gone: { origin: "https://example.com", key: "deleted" },
  });
  expect(fake.read).toHaveBeenCalledOnce();
  stop();
});

it("invalidates both provider and endpoint credentials before a refresh finishes", async () => {
  fake.subscribe.mockResolvedValue(vi.fn());
  fake.read.mockResolvedValue({ openai: "old" });
  fake.prefs.customEndpoints = [
    {
      id: "e",
      name: "E",
      baseURL: "https://e.test",
      modelId: "m",
      contextLimit: 10000,
    },
  ];
  fake.readEndpoints.mockResolvedValue({
    e: { origin: "https://e.test", key: "old" },
  });
  const stop = start();
  await flush();
  const providerRead = deferred<object>();
  const endpointRead = deferred<object>();
  fake.read.mockReturnValue(providerRead.promise);
  fake.readEndpoints.mockReturnValue(endpointRead.promise);
  fake.subscribe.mock.calls[0][0]();
  expect(fake.setKeys).toHaveBeenLastCalledWith(
    expect.objectContaining({ openai: { status: "loading" } }),
  );
  expect(fake.setEndpoints).toHaveBeenLastCalledWith({
    e: { status: "loading" },
  });
  providerRead.resolve({ openai: { status: "failed", error: "locked" } });
  endpointRead.resolve({ e: { status: "failed", error: "locked" } });
  await flush();
  expect(fake.setEndpoints).toHaveBeenLastCalledWith({
    e: { status: "failed", error: "locked" },
  });
  stop();
});

it.each(["loading", "failed"] as const)(
  "keeps the loaded composer mounted while credentials are %s",
  (status) => {
    fake.keysLoaded = true;
    fake.apiKeys = { openai: { status } };
    expect(useAiBootstrap().hasComposer).toBe(true);
  },
);
it("does not mount the composer solely for the initial pending lookup or confirmed missing keys", () => {
  fake.apiKeys = { openai: { status: "loading" } };
  expect(useAiBootstrap().hasComposer).toBe(false);
  fake.keysLoaded = true;
  fake.apiKeys = { openai: null };
  expect(useAiBootstrap().hasComposer).toBe(false);
});
