import { createProxyFetch, proxyFetch } from "@/modules/ai/lib/proxyFetch";

vi.mock("@/lib/networkPage", () => ({ networkPage: async () => "test-page" }));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  channels: [] as { onmessage: (value: ArrayBuffer) => void }[],
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: bridge.invoke,
  Channel: class {
    onmessage = (_value: ArrayBuffer) => {};
    constructor() {
      bridge.channels.push(this);
    }
    toJSON() {
      return "__CHANNEL__:1";
    }
  },
}));

beforeEach(() => {
  bridge.channels.length = 0;
  bridge.invoke.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());
const encoder = new TextEncoder();
function packet(kind: number, value: string | Uint8Array = "") {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const result = new Uint8Array(bytes.length + 1);
  result[0] = kind;
  result.set(bytes, 1);
  bridge.channels[0].onmessage(result.buffer);
}
function headers(status = 200) {
  packet(
    0,
    JSON.stringify({ status, headers: { "content-type": "text/plain" } }),
  );
}
async function started() {
  await vi.waitFor(() =>
    expect(
      bridge.invoke.mock.calls.some(
        ([command]) => command === "ai_http_stream",
      ),
    ).toBe(true),
  );
}
const calls = (command: string) =>
  bridge.invoke.mock.calls.filter(([name]) => name === command);

describe("native AI fetch transport", () => {
  it("retains the native status description for an empty error response", async () => {
    const pending = proxyFetch("https://example.test");
    await started();
    packet(
      0,
      JSON.stringify({
        status: 503,
        statusText: "Service Unavailable",
        headers: [],
      }),
    );
    packet(2);
    const response = await pending;
    expect(await response.text()).toBe("");
    expect(response.statusText).toBe("Service Unavailable");
  });

  it("preserves repeated authentication and cookie response headers", async () => {
    const pending = proxyFetch("https://example.test");
    await started();
    const cookies = [
      "a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT",
      "b=2; Path=/",
    ];
    packet(
      0,
      JSON.stringify({
        status: 401,
        headers: [
          ["www-authenticate", "Bearer realm=api"],
          ["www-authenticate", "Basic realm=legacy"],
          ...cookies.map((value) => ["set-cookie", value]),
        ],
      }),
    );
    const response = await pending;
    expect(response.headers.get("www-authenticate")).toBe(
      "Bearer realm=api, Basic realm=legacy",
    );
    expect(response.headers.getSetCookie()).toEqual(cookies);
    packet(2);
    expect(await response.text()).toBe("");
  });

  it("preserves the caller's abort reason before request admission", async () => {
    const owner = new AbortController();
    const reason = new DOMException("Deadline exceeded", "TimeoutError");
    owner.abort(reason);
    await expect(
      proxyFetch("https://example.test", { signal: owner.signal }),
    ).rejects.toBe(reason);
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it("cancels a pending request-body read with its original reason and sends no request", async () => {
    const owner = new AbortController();
    const reason = new Error("Upload cancelled by its owner");
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const pending = proxyFetch("https://example.test", {
      method: "POST",
      body,
      signal: owner.signal,
      duplex: "half",
    } as RequestInit);
    const rejected = expect(pending).rejects.toBe(reason);
    await Promise.resolve();
    owner.abort(reason);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it("preserves abort reasons while waiting for response headers or body", async () => {
    for (const established of [false, true]) {
      const owner = new AbortController();
      const reason = new DOMException("Deadline exceeded", "TimeoutError");
      const pending = proxyFetch("https://example.test", {
        signal: owner.signal,
      });
      await started();
      let rejected: Promise<void>;
      if (established) {
        headers();
        rejected = expect((await pending).text()).rejects.toBe(reason);
      } else {
        rejected = expect(pending).rejects.toBe(reason);
      }
      owner.abort(reason);
      await rejected;
      expect(calls("ai_http_cancel").length).toBeGreaterThan(0);
      bridge.channels.length = 0;
      bridge.invoke.mockClear();
    }
  });

  it("sends binary bodies and preserves Request input, headers, and Unicode metadata", async () => {
    const request = new Request("https://example.test/日本語", {
      method: "POST",
      headers: { "x-test": "yes" },
      body: "hello 日本語",
    });
    const pending = createProxyFetch({ allowPrivateNetwork: true })(request);
    await started();
    const [, body, options] = calls("ai_http_stream")[0];
    expect(body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(body)).toBe("hello 日本語");
    expect(JSON.parse(options.headers["x-oarlock-ai-request"])).toMatchObject({
      method: "POST",
      pageGeneration: "test-page",
      headers: { "x-test": "yes" },
      allowPrivateNetwork: true,
      onEvent: "__CHANNEL__:1",
    });
    expect(options.headers["x-oarlock-ai-request"]).not.toMatch(/[^\x20-\x7e]/);
    headers();
    const response = await pending;
    packet(1, "a");
    packet(1, "b");
    packet(2);
    expect(await response.text()).toBe("ab");
  });

  it("holds native credit while the consumer is stalled, then acknowledges complete byte offsets", async () => {
    const pending = proxyFetch("https://example.test");
    await started();
    headers();
    const response = await pending;
    const chunk = new Uint8Array(64 * 1024).fill(65);
    packet(1, chunk);
    packet(1, chunk);
    await Promise.resolve();
    expect(calls("ai_http_ack")).toHaveLength(0);
    if (!response.body) throw new Error("Missing response body");
    const reader = response.body.getReader();
    expect((await reader.read()).value).toEqual(chunk);
    expect((await reader.read()).value).toEqual(chunk);
    await vi.waitFor(() => expect(calls("ai_http_ack")).toHaveLength(1));
    expect(calls("ai_http_ack")[0][1]).toMatchObject({
      bytes: 128 * 1024,
      pageGeneration: "test-page",
    });
    packet(2);
    expect((await reader.read()).done).toBe(true);
  });

  it("does not spend an IPC call per small chunk and acknowledges at half the native window", async () => {
    const pending = proxyFetch("https://example.test");
    await started();
    headers();
    const response = await pending;
    if (!response.body) throw new Error("Missing response body");
    const reader = response.body.getReader();
    const small = new Uint8Array(100).fill(66);
    for (let i = 0; i < 100; i += 1) {
      packet(1, small);
      expect((await reader.read()).value).toEqual(small);
    }
    await Promise.resolve();
    expect(calls("ai_http_ack")).toHaveLength(0);

    const chunk = new Uint8Array(32 * 1024).fill(67);
    packet(1, chunk);
    await reader.read();
    await Promise.resolve();
    expect(calls("ai_http_ack")).toHaveLength(0);
    packet(1, chunk);
    await reader.read();
    await vi.waitFor(() => expect(calls("ai_http_ack")).toHaveLength(1));
    expect(calls("ai_http_ack")[0][1].bytes).toBe(100 * 100 + 64 * 1024);
    packet(2);
    expect((await reader.read()).done).toBe(true);
  });

  it("acknowledges a long run of tiny packets before the native packet ledger fills", async () => {
    const pending = proxyFetch("https://example.test");
    await started();
    headers();
    const response = await pending;
    if (!response.body) throw new Error("Missing response body");
    const reader = response.body.getReader();
    for (let i = 0; i < 127; i += 1) {
      packet(1, "x");
      await reader.read();
    }
    await Promise.resolve();
    expect(calls("ai_http_ack")).toHaveLength(0);
    packet(1, "x");
    await reader.read();
    await vi.waitFor(() => expect(calls("ai_http_ack")).toHaveLength(1));
    expect(calls("ai_http_ack")[0][1].bytes).toBe(128);
    packet(2);
    expect((await reader.read()).done).toBe(true);
  });

  it("cancels native work before and after a delayed startup acknowledgment", async () => {
    let finishStart!: () => void;
    bridge.invoke.mockImplementation((command) =>
      command === "ai_http_stream"
        ? new Promise<void>((resolve) => {
            finishStart = resolve;
          })
        : Promise.resolve(),
    );
    const abort = new AbortController();
    const pending = proxyFetch("https://example.test", {
      signal: abort.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await started();
    abort.abort();
    await rejected;
    expect(calls("ai_http_cancel")).toHaveLength(1);
    expect(calls("ai_http_cancel")[0][1].pageGeneration).toBe("test-page");
    finishStart();
    await vi.waitFor(() => expect(calls("ai_http_cancel")).toHaveLength(2));
    packet(0, "ignored after cancellation");
  });

  it("cancels native work when an established response body is cancelled", async () => {
    const pending = proxyFetch("https://example.test");
    await started();
    headers();
    const response = await pending;
    if (!response.body) throw new Error("Missing response body");
    await response.body.cancel();
    expect(calls("ai_http_cancel")).toHaveLength(1);
    packet(1, "ignored");
    expect(calls("ai_http_ack")).toHaveLength(0);
  });

  it("fails and cancels an established stream when credit delivery fails", async () => {
    bridge.invoke.mockImplementation((command) =>
      command === "ai_http_ack"
        ? Promise.reject(new Error("connection lost"))
        : Promise.resolve(),
    );
    const pending = proxyFetch("https://example.test");
    await started();
    headers();
    const response = await pending;
    const body = expect(response.text()).rejects.toThrow("connection lost");
    packet(1, new Uint8Array(64 * 1024).fill(72));
    await body;
    expect(calls("ai_http_cancel")).toHaveLength(1);
  });

  it("handles responses that cannot carry a body and removes the abort listener on completion", async () => {
    const abort = new AbortController();
    const pending = proxyFetch("https://example.test", {
      signal: abort.signal,
    });
    await started();
    headers(204);
    const response = await pending;
    expect(response.body).toBeNull();
    const count = calls("ai_http_cancel").length;
    abort.abort();
    expect(calls("ai_http_cancel")).toHaveLength(count);
  });
});

describe("MCP sessions", () => {
  it("goes through the MCP commands with the session, not the AI proxy's", async () => {
    const { createMcpFetch } = await import("@/modules/ai/lib/proxyFetch");
    const pending = createMcpFetch(7)("https://mcp.example.com/mcp", {
      method: "POST",
      body: '{"jsonrpc":"2.0"}',
    });
    await vi.waitFor(() =>
      expect(
        bridge.invoke.mock.calls.some(([c]) => c === "mcp_http_stream"),
      ).toBe(true),
    );
    const [, , options] = calls("mcp_http_stream")[0] as [
      string,
      unknown,
      { headers: Record<string, string> },
    ];
    const metadata = JSON.parse(options.headers["x-oarlock-mcp-request"]);
    expect(metadata).toMatchObject({
      session: 7,
      pageGeneration: "test-page",
      url: "https://mcp.example.com/mcp",
      method: "POST",
    });
    expect(metadata).not.toHaveProperty("allowPrivateNetwork");
    expect(calls("ai_http_stream")).toEqual([]);
    headers();
    packet(2);
    const response = await pending;
    expect(await response.text()).toBe("");
  });
});
