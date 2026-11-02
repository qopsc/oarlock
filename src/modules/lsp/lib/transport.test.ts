vi.mock("@/lib/networkPage", () => ({ networkPage: async () => "page" }));
import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => {
  const channels: { onmessage: ((buf: never) => void) | null }[] = [];
  const invoke = vi.fn(async () => 77);
  class Channel {
    onmessage: ((buf: never) => void) | null = null;
    constructor() {
      channels.push(this);
    }
  }
  return { channels, invoke, Channel };
});

vi.mock("@tauri-apps/api/core", () => ({
  Channel: core.Channel,
  invoke: core.invoke,
}));

vi.mock("@/modules/workspace", () => ({ currentWorkspaceEnv: () => "local" }));

import { TauriLspTransport } from "./transport";

function lastTwoChannels() {
  const [onMessage, onExit] = core.channels.slice(-2);
  return {
    pushMessage: (text: string) =>
      (onMessage.onmessage as unknown as ((b: ArrayBuffer) => void) | null)?.(
        new TextEncoder().encode(text).buffer as ArrayBuffer,
      ),
    pushExit: (info: unknown) =>
      (onExit.onmessage as unknown as ((i: unknown) => void) | null)?.(info),
  };
}

function spawnArgs(): Record<string, unknown> {
  const calls = core.invoke.mock.calls as unknown as [
    string,
    Record<string, unknown>,
  ][];
  const call = calls.find((c) => c[0] === "lsp_spawn");
  if (!call) throw new Error("lsp_spawn was not called");
  return call[1];
}

async function startedTransport() {
  const t = new TauriLspTransport();
  await t.start({
    command: "rust-analyzer",
    args: [],
    root: "/repo",
    maxMemoryMb: 2048,
  });
  return t;
}

describe("TauriLspTransport", () => {
  beforeEach(() => {
    core.channels.length = 0;
    core.invoke.mockClear();
    core.invoke.mockResolvedValue(77);
  });

  it("spawns the server with the workspace scope and channel callbacks", async () => {
    await startedTransport();

    expect(spawnArgs()).toMatchObject({
      command: "rust-analyzer",
      args: [],
      env: null,
      root: "/repo",
      maxRssMb: 2048,
      workspace: { kind: "local" },
      shell: null,
    });
  });

  it("buffers early messages and replays them when a listener attaches", async () => {
    const t = await startedTransport();
    const io = lastTwoChannels();
    io.pushMessage('{"jsonrpc":"2.0","method":"early"}');

    const seen: string[] = [];
    t.onMessage((m) => seen.push(m));
    io.pushMessage('{"jsonrpc":"2.0","method":"live"}');

    expect(seen).toEqual([
      '{"jsonrpc":"2.0","method":"early"}',
      '{"jsonrpc":"2.0","method":"live"}',
    ]);
  });

  it("answers workspace/configuration with one null per requested item", async () => {
    const t = await startedTransport();
    t.onMessage(() => {});
    lastTwoChannels().pushMessage(
      '{"jsonrpc":"2.0","id":5,"method":"workspace/configuration","params":{"items":[{},{}]}}',
    );

    expect(core.invoke).toHaveBeenCalledWith(
      "lsp_send",
      expect.objectContaining({
        id: 77,
        message: '{"jsonrpc":"2.0","id":5,"result":[null,null]}',
      }),
    );
  });

  it("acks known capability requests and method-not-found for the rest", async () => {
    const t = await startedTransport();
    t.onMessage(() => {});

    lastTwoChannels().pushMessage(
      '{"jsonrpc":"2.0","id":6,"method":"client/registerCapability"}',
    );
    expect(core.invoke).toHaveBeenLastCalledWith(
      "lsp_send",
      expect.objectContaining({
        message: '{"jsonrpc":"2.0","id":6,"result":null}',
      }),
    );

    lastTwoChannels().pushMessage(
      '{"jsonrpc":"2.0","id":7,"method":"some/futureMethod"}',
    );
    await Promise.resolve();
    expect(core.invoke).toHaveBeenLastCalledWith(
      "lsp_send",
      expect.objectContaining({
        message:
          '{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"unhandled method some/futureMethod"}}',
      }),
    );
  });

  it("never answers notifications or responses", async () => {
    const t = await startedTransport();
    t.onMessage(() => {});

    lastTwoChannels().pushMessage(
      '{"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{}}',
    );
    lastTwoChannels().pushMessage('{"jsonrpc":"2.0","id":9,"result":{}}');
    lastTwoChannels().pushMessage("not json at all");

    expect(core.invoke).not.toHaveBeenCalledWith("lsp_send", expect.anything());
  });

  it("drops sends before start and after close", async () => {
    const t = new TauriLspTransport();
    t.send("{}");
    expect(core.invoke).not.toHaveBeenCalledWith("lsp_send", expect.anything());

    await t.start({
      command: "rust-analyzer",
      args: [],
      root: "/repo",
    });
    t.close();
    t.send("{}");

    expect(core.invoke).not.toHaveBeenCalledWith("lsp_send", expect.anything());
  });

  it("routes send failures to the error callback", async () => {
    const t = await startedTransport();
    t.onMessage(() => {});
    const onError = vi.fn();
    t.onError(onError);
    core.invoke.mockRejectedValueOnce(new Error("pipe broken"));

    t.send("{}");
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({}));
  });

  it("records exit info, fires onClose, and stays closed afterwards", async () => {
    const t = await startedTransport();
    const onClosed = vi.fn();
    t.onClose(onClosed);

    const info = { code: 0, stderrTail: "", reason: "budget" };
    lastTwoChannels().pushExit(info);

    expect(t.exitInfo).toEqual(info);
    expect(onClosed).toHaveBeenCalledTimes(1);

    t.onClose(onClosed);
    expect(onClosed).toHaveBeenCalledTimes(2);

    t.close();
    expect(core.invoke).not.toHaveBeenCalledWith("lsp_kill", expect.anything());
  });

  it("kills the session on close and tolerates repeated closes", async () => {
    const t = await startedTransport();
    t.close();
    t.close();

    expect(core.invoke).toHaveBeenCalledWith("lsp_kill", {
      id: 77,
      pageGeneration: "page",
    });
    const killCalls = (
      core.invoke.mock.calls as unknown as [string, unknown][]
    ).filter((c) => c[0] === "lsp_kill");
    expect(killCalls).toHaveLength(1);
  });

  it("rejects malformed configuration parameters without throwing", async () => {
    await startedTransport();
    expect(() =>
      lastTwoChannels().pushMessage(
        '{"jsonrpc":"2.0","id":5,"method":"workspace/configuration","params":{"items":"invalid"}}',
      ),
    ).not.toThrow();
    expect(core.invoke).toHaveBeenCalledWith(
      "lsp_send",
      expect.objectContaining({
        message:
          '{"jsonrpc":"2.0","id":5,"error":{"code":-32602,"message":"Invalid configuration items"}}',
      }),
    );
  });

  it("discards buffered and late messages after close", async () => {
    const t = await startedTransport();
    const io = lastTwoChannels();
    io.pushMessage('{"jsonrpc":"2.0","method":"early"}');
    t.close();
    const received = vi.fn();
    t.onMessage(received);
    io.pushMessage('{"jsonrpc":"2.0","method":"late"}');
    expect(received).not.toHaveBeenCalled();
  });
});

it("kills a delayed startup reply after close instead of resurrecting the transport", async () => {
  core.invoke.mockClear();
  let finish!: (id: number) => void;
  core.invoke.mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  );
  const t = new TauriLspTransport();
  const starting = t.start({ command: "test", args: [], root: "/repo" });
  await vi.waitFor(() => expect(finish).toBeDefined());
  t.close();
  finish(91);
  await starting;
  t.send("{}");
  expect(core.invoke).toHaveBeenCalledWith("lsp_kill", {
    id: 91,
    pageGeneration: "page",
  });
  expect(core.invoke).not.toHaveBeenCalledWith("lsp_send", expect.anything());
});

it("preserves write order when native IPC takes different amounts of time", async () => {
  core.invoke.mockResolvedValue(77);
  const t = await startedTransport();
  const received: string[] = [];
  let finish!: () => void;
  core.invoke
    .mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = () => {
            received.push("didOpen");
            resolve(0);
          };
        }),
    )
    .mockImplementationOnce(async () => {
      received.push("didChange");
      return 0;
    });
  t.send("didOpen");
  t.send("didChange");
  await vi.waitFor(() => expect(finish).toBeDefined());
  finish();
  await vi.waitFor(() => expect(received).toHaveLength(2));
  t.close();
  expect(received).toEqual(["didOpen", "didChange"]);
});

it("does not launch every write concurrently against a stalled server", async () => {
  core.invoke.mockResolvedValue(77);
  const t = await startedTransport();
  core.invoke.mockClear();
  core.invoke.mockImplementation(() => new Promise<number>(() => {}));
  for (let i = 0; i < 257; i++) t.send(`change-${i}`);
  const concurrent = (core.invoke.mock.calls as unknown as [string][]).filter(
    ([command]) => command === "lsp_send",
  ).length;
  t.close();
  expect(concurrent).toBe(1);
});

it("answers a server request once when the real protocol client is attached", async () => {
  core.invoke.mockResolvedValue(77);
  const t = await startedTransport();
  const { OarlockLspClient } = await import("./client");
  const client = new OarlockLspClient({
    transport: t,
    rootUri: "file:///repo",
    documentUri: "file:///repo/a.ts",
    workspaceFolders: [],
    languageId: "typescript",
    onError: () => {},
  });
  await Promise.resolve();
  await Promise.resolve();
  lastTwoChannels().pushMessage(
    '{"jsonrpc":"2.0","id":42,"method":"workspace/configuration","params":{"items":[{},{}]}}',
  );
  await Promise.resolve();
  await Promise.resolve();
  const replies = (
    core.invoke.mock.calls as unknown as [string, { message?: string }][]
  )
    .filter(
      ([command, args]) =>
        command === "lsp_send" && JSON.parse(args.message ?? "{}").id === 42,
    )
    .map(([, args]) => JSON.parse(args.message ?? "{}"));
  client.close();
  await client.initializePromise;
  expect(replies).toEqual([{ jsonrpc: "2.0", id: 42, result: [null, null] }]);
});

it("answers requests delivered before the spawn acknowledgment once an ID exists", async () => {
  core.invoke.mockClear();
  core.invoke.mockResolvedValue(77);
  let finish!: (id: number) => void;
  core.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const t = new TauriLspTransport();
  const starting = t.start({ command: "test", args: [], root: "/repo" });
  await vi.waitFor(() => expect(finish).toBeDefined());
  lastTwoChannels().pushMessage(
    '{"jsonrpc":"2.0","id":0,"method":"workspace/configuration","params":{"items":[{}]}}',
  );
  finish(77);
  await starting;
  const received = vi.fn();
  t.onMessage(received);
  expect(core.invoke).toHaveBeenCalledWith(
    "lsp_send",
    expect.objectContaining({
      id: 77,
      message: '{"jsonrpc":"2.0","id":0,"result":[null]}',
    }),
  );
  expect(received).not.toHaveBeenCalled();
  t.close();
});

it("overflow closes once, preserves its reason after native exit and does not close another transport", async () => {
  core.invoke.mockResolvedValue(77);
  const first = await startedTransport();
  const firstIo = lastTwoChannels();
  core.invoke.mockResolvedValueOnce(78);
  const second = await startedTransport();
  const closed = vi.fn();
  const otherClosed = vi.fn();
  first.onClose(closed);
  second.onClose(otherClosed);
  core.invoke.mockClear();
  core.invoke.mockImplementation(() => new Promise<number>(() => {}));
  for (let i = 0; i < 257; i++) first.send("change");
  expect(closed).toHaveBeenCalledTimes(1);
  expect(first.exitInfo?.reason).toContain("256 messages");
  expect(core.invoke).toHaveBeenCalledWith("lsp_kill", {
    id: 77,
    pageGeneration: "page",
  });
  firstIo.pushExit({ code: null, stderrTail: "", reason: null });
  expect(first.exitInfo?.reason).toContain("256 messages");
  expect(closed).toHaveBeenCalledTimes(1);
  expect(otherClosed).not.toHaveBeenCalled();
  second.send("other document");
  expect(core.invoke).toHaveBeenCalledWith(
    "lsp_send",
    expect.objectContaining({ id: 78, message: "other document" }),
  );
  second.close();
});
