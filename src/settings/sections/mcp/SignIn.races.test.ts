import { beforeEach, expect, it, vi } from "vitest";
import type { AuthStatus } from "@/modules/mcp/lib/auth";
import type { McpServerConfig } from "@/modules/mcp/lib/config";
const fake = vi.hoisted(() => ({
  cells: [] as unknown[],
  index: 0,
  effects: [] as (() => unknown)[],
  invoke: vi.fn(),
  listener: () => {},
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
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown, deps: unknown[]) => {
    const i = fake.index++;
    const old = fake.cells[i] as
      | { deps: unknown[]; value: unknown }
      | undefined;
    if (!old || deps.some((d, j) => d !== old.deps[j]))
      fake.cells[i] = { deps, value: fn() };
    return (fake.cells[i] as { value: unknown }).value;
  },
  useEffect: (fn: () => unknown) => {
    fake.effects.push(fn);
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("./metadataProbe", () => ({
  requestMetadataProbe: (server: McpServerConfig, signal: AbortSignal) => {
    signal.addEventListener(
      "abort",
      () => {
        void fake.invoke("mcp_oauth_probe_cancel");
      },
      { once: true },
    );
    return fake.invoke("mcp_oauth_probe", { serverId: server.id });
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (_: string, callback: () => void) => {
    fake.listener = callback;
    return () => {};
  }),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: { getState: () => ({}) },
}));
import { useSignIn } from "./SignIn";
import { emit } from "@tauri-apps/api/event";
const server: McpServerConfig = {
  id: "a",
  name: "A",
  source: "settings",
  enabled: true,
  trusted: false,
  tools: {},
  secretsRevision: 0,
  transport: { type: "http", url: "https://one.example/mcp", headers: [] },
};
function status(state: AuthStatus["state"]): AuthStatus {
  return {
    serverId: "a",
    state,
    reason: null,
    requiredScope: null,
    scope: null,
    issuer: null,
    expiresAtMs: null,
    canRefresh: false,
    signingIn: false,
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function render(servers: McpServerConfig[]) {
  fake.index = 0;
  fake.effects = [];
  // biome-ignore lint/correctness/useHookAtTopLevel: React hooks are mocked by this deterministic async harness.
  return useSignIn(servers);
}
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}
beforeEach(() => {
  vi.mocked(emit).mockClear();
  fake.cells = [];
  fake.index = 0;
  fake.effects = [];
  fake.invoke
    .mockReset()
    .mockImplementation(async (cmd: string) =>
      cmd === "mcp_oauth_status" ? [status("none")] : status("none"),
    );
});
it("an older status response cannot undo a newer signed-out status", async () => {
  const first = deferred<AuthStatus[]>(),
    second = deferred<AuthStatus[]>();
  fake.invoke
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const list = [server];
  render(list);
  fake.effects.forEach((fn) => {
    fn();
  });
  fake.listener();
  second.resolve([status("none")]);
  await flush();
  first.resolve([status("signed-in")]);
  await flush();
  expect(render(list).statuses.a.state).toBe("none");
});
it("a response from the previous URL cannot probe or label the newly disabled server", async () => {
  const first = deferred<AuthStatus[]>(),
    second = deferred<AuthStatus[]>();
  fake.invoke
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  render([server]);
  fake.effects.forEach((fn) => {
    fn();
  });
  const next = [
    {
      ...server,
      enabled: false,
      secretsRevision: 1,
      transport: {
        type: "http" as const,
        url: "https://two.example/mcp",
        headers: [],
      },
    },
  ];
  render(next);
  fake.effects.forEach((fn) => {
    fn();
  });
  second.resolve([status("none")]);
  await flush();
  first.resolve([status("none")]);
  await flush();
  expect(
    fake.invoke.mock.calls.filter(([cmd]) => cmd === "mcp_oauth_probe"),
  ).toHaveLength(0);
});
it("a sign-in result from the previous credential version cannot relabel its replacement", async () => {
  const signedIn = deferred<AuthStatus>();
  fake.invoke
    .mockReturnValueOnce(signedIn.promise)
    .mockResolvedValueOnce([status("none")]);
  render([server]).signIn(server);
  const next = [{ ...server, enabled: false, secretsRevision: 1 }];
  render(next);
  fake.effects.forEach((fn) => {
    fn();
  });
  await flush();
  signedIn.resolve(status("signed-in"));
  await flush();
  expect(render(next).statuses.a.state).toBe("none");
});
it("an old failed sign-in cannot replace the error of a newer action", async () => {
  let reject!: (e: Error) => void;
  const old = new Promise((_resolve, r) => {
    reject = r;
  });
  const latest = deferred<AuthStatus>();
  fake.invoke.mockReturnValueOnce(old).mockReturnValueOnce(latest.promise);
  const list = [server];
  const controls = render(list);
  controls.signIn(server);
  controls.signIn(server);
  reject(new Error("old sign-in cancelled"));
  await flush();
  latest.resolve(status("signed-in"));
  await flush();
  expect(render(list).errors.a).toBeUndefined();
});

it("a rejected cancel preserves the saving sign-in's completion and reconnect", async () => {
  const signedIn = deferred<AuthStatus>();
  fake.invoke
    .mockReturnValueOnce(signedIn.promise)
    .mockRejectedValueOnce(new Error("saving sign-in"))
    .mockResolvedValueOnce([
      { ...status("none"), signingIn: true, saving: true },
    ]);
  const list = [server];
  const controls = render(list);
  controls.signIn(server);
  controls.cancel(server);
  await flush();
  expect(render(list).errors.a).toContain("saving sign-in");
  signedIn.resolve(status("signed-in"));
  await flush();
  expect(render(list).statuses.a.state).toBe("signed-in");
  expect(render(list).errors.a).toBeUndefined();
  expect(emit).toHaveBeenCalledWith("oarlock://mcp-restart", { serverId: "a" });
});

it("never starts metadata discovery while sign-in is pending or saving", async () => {
  for (const saving of [false, true]) {
    fake.invoke
      .mockClear()
      .mockResolvedValueOnce([{ ...status("none"), signingIn: true, saving }]);
    render([server]);
    fake.effects.forEach((fn) => {
      fn();
    });
    await flush();
    expect(
      fake.invoke.mock.calls.some(([cmd]) => cmd === "mcp_oauth_probe"),
    ).toBe(false);
  }
});

it("refreshes the committed sign-out state when registration cleanup fails", async () => {
  const list = [{ ...server, enabled: false }];
  fake.invoke.mockResolvedValueOnce([status("signed-in")]);
  render(list);
  fake.effects.forEach((fn) => {
    fn();
  });
  await flush();
  expect(render(list).statuses.a.state).toBe("signed-in");
  fake.invoke
    .mockRejectedValueOnce(new Error("registration cleanup failed"))
    .mockResolvedValueOnce([status("none")]);
  render(list).signOut(list[0]);
  await flush();
  expect(render(list).statuses.a.state).toBe("none");
  expect(render(list).errors.a).toContain("registration cleanup failed");
});

it("a second sign-in rejected during saving cannot suppress the saved sign-in's reconnect", async () => {
  const saved = deferred<AuthStatus>();
  fake.invoke
    .mockReturnValueOnce(saved.promise)
    .mockRejectedValueOnce(new Error("saving sign-in"));
  const controls = render([server]);
  controls.signIn(server);
  controls.signIn(server);
  await flush();
  saved.resolve(status("signed-in"));
  await flush();
  expect(emit).toHaveBeenCalledWith("oarlock://mcp-restart", { serverId: "a" });
});

it("closing Settings cancels unfinished automatic metadata discovery", async () => {
  const discovery = deferred<AuthStatus>();
  fake.invoke.mockImplementation((cmd: string) =>
    cmd === "mcp_oauth_probe"
      ? discovery.promise
      : Promise.resolve([status("none")]),
  );
  render([server]);
  const cleanups = fake.effects.map((effect) => effect());
  await flush();
  expect(
    fake.invoke.mock.calls.filter(([cmd]) => cmd === "mcp_oauth_probe"),
  ).toHaveLength(1);
  for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
  const cancelled = fake.invoke.mock.calls.some(
    ([cmd]) => cmd === "mcp_oauth_probe_cancel",
  );
  discovery.resolve(status("none"));
  await flush();
  expect(cancelled).toBe(true);
});

it("does not fan out every configured metadata probe simultaneously", async () => {
  const list = Array.from({ length: 17 }, (_, i) => ({
    ...server,
    id: `server-${i}`,
  }));
  const discovery = deferred<AuthStatus>();
  fake.invoke.mockImplementation((cmd: string) =>
    cmd === "mcp_oauth_probe"
      ? discovery.promise
      : Promise.resolve(
          list.map((entry) => ({ ...status("none"), serverId: entry.id })),
        ),
  );
  render(list);
  fake.effects.forEach((effect) => {
    effect();
  });
  await flush();
  const starts = fake.invoke.mock.calls.filter(
    ([cmd]) => cmd === "mcp_oauth_probe",
  ).length;
  discovery.resolve(status("none"));
  await flush();
  expect(starts).toBeLessThanOrEqual(8);
});

it("a failed metadata lookup is visible and retried explicitly", async () => {
  fake.invoke.mockImplementation((cmd: string) =>
    cmd === "mcp_oauth_probe"
      ? Promise.reject(new Error("HTTP 503"))
      : Promise.resolve([status("none")]),
  );
  render([server]);
  fake.effects.forEach((effect) => {
    effect();
  });
  await flush();
  fake.listener();
  await flush();
  expect(
    fake.invoke.mock.calls.filter(([cmd]) => cmd === "mcp_oauth_probe"),
  ).toHaveLength(1);
  const controls = render([server]);
  expect(controls.discoveryErrors.a).toContain("HTTP 503");
  controls.retryDiscovery(server);
  await flush();
  expect(
    fake.invoke.mock.calls.filter(([cmd]) => cmd === "mcp_oauth_probe"),
  ).toHaveLength(2);
});

it("disabling a server cancels active discovery and rejects its late result", async () => {
  const discovery = deferred<AuthStatus>();
  fake.invoke.mockImplementation((cmd: string) =>
    cmd === "mcp_oauth_probe"
      ? discovery.promise
      : Promise.resolve([status("none")]),
  );
  render([server]);
  fake.effects.forEach((effect) => {
    effect();
  });
  await flush();
  const disabled = [{ ...server, enabled: false }];
  render(disabled);
  fake.effects.forEach((effect) => {
    effect();
  });
  await flush();
  expect(
    fake.invoke.mock.calls.some(([cmd]) => cmd === "mcp_oauth_probe_cancel"),
  ).toBe(true);
  discovery.resolve(status("required"));
  await flush();
  expect(render(disabled).statuses.a.state).toBe("none");
});

it("sign-in cancels discovery and refresh cannot restart it during the action", async () => {
  const discovery = deferred<AuthStatus>(),
    signedIn = deferred<AuthStatus>();
  fake.invoke.mockImplementation((cmd: string) =>
    cmd === "mcp_oauth_probe"
      ? discovery.promise
      : cmd === "mcp_oauth_sign_in"
        ? signedIn.promise
        : Promise.resolve([status("none")]),
  );
  const list = [server];
  render(list);
  fake.effects.forEach((effect) => {
    effect();
  });
  await flush();
  render(list).signIn(server);
  fake.listener();
  await flush();
  expect(
    fake.invoke.mock.calls.some(([cmd]) => cmd === "mcp_oauth_probe_cancel"),
  ).toBe(true);
  expect(
    fake.invoke.mock.calls.filter(([cmd]) => cmd === "mcp_oauth_probe"),
  ).toHaveLength(1);
  discovery.resolve(status("required"));
  signedIn.resolve(status("signed-in"));
  await flush();
  expect(render(list).statuses.a.state).toBe("signed-in");
});

it("an edited configuration does not display the previous discovery failure", async () => {
  fake.invoke.mockImplementation((cmd: string) =>
    cmd === "mcp_oauth_probe"
      ? Promise.reject(new Error("old URL failed"))
      : Promise.resolve([status("none")]),
  );
  render([server]);
  fake.effects.forEach((effect) => {
    effect();
  });
  await flush();
  expect(render([server]).discoveryErrors.a).toContain("old URL");
  expect(
    render([{ ...server, secretsRevision: 1 }]).discoveryErrors.a,
  ).toBeUndefined();
});
