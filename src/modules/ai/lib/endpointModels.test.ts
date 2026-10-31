import { describe, expect, it, vi } from "vitest";
import { listEndpointModels, parseModelList } from "./endpointModels";

describe("listEndpointModels", () => {
  it("asks the server's /models with the endpoint key and lists the ids sorted", async () => {
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "qwen3-coder", object: "model" },
              { id: "deepseek-v4-pro", object: "model" },
              { id: "qwen3-coder" },
            ],
          }),
        ),
    );
    const ids = await listEndpointModels(
      "https://opencode.ai/zen/go/v1/",
      "sk-ep",
      fetchImpl as unknown as typeof fetch,
    );
    expect(ids).toEqual(["deepseek-v4-pro", "qwen3-coder"]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://opencode.ai/zen/go/v1/models");
    expect(init?.headers).toEqual({ Authorization: "Bearer sk-ep" });
  });

  it("sends no Authorization header without a key", async () => {
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [] })),
    );
    await listEndpointModels(
      "http://127.0.0.1:11434/v1",
      null,
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual({});
  });

  it("reports the server's error", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          error: { code: "invalid_api_key", message: "Incorrect API key." },
        }),
        { status: 401 },
      );
    await expect(
      listEndpointModels("https://llm.example.com/v1", "bad", fetchImpl),
    ).rejects.toThrow("HTTP 401: Authentication failed: Incorrect API key.");
  });
});

describe("parseModelList", () => {
  it("refuses a body that is not an OpenAI model list", () => {
    expect(() => parseModelList({ models: [] })).toThrow(/OpenAI format/);
    expect(() => parseModelList(null)).toThrow(/OpenAI format/);
  });
});

it("forwards cancellation to the native fetch transport", async () => {
  const controller = new AbortController();
  const fetchImpl = vi.fn(
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false);
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      init?.signal?.throwIfAborted();
      return new Response();
    },
  );
  await expect(
    listEndpointModels(
      "https://example.com/v1",
      null,
      fetchImpl,
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
});

it("stops an oversized streamed model list before buffering it all", async () => {
  let chunks = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks++;
      if (chunks <= 5) controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
      else {
        controller.enqueue(new TextEncoder().encode('{"data":[]}'));
        controller.close();
      }
    },
    cancel,
  });
  await expect(
    listEndpointModels(
      "https://example.test/v1",
      null,
      async () => new Response(body),
    ),
  ).rejects.toThrow(/large|limit/i);
  expect(cancel).toHaveBeenCalledOnce();
});

it("times out when the server sends headers but never finishes the model list", async () => {
  vi.useFakeTimers();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
  });
  let error: unknown;
  const pending = listEndpointModels(
    "https://example.test/v1",
    null,
    async () => new Response(body),
  ).catch((value) => {
    error = value;
  });
  try {
    await vi.advanceTimersByTimeAsync(31_000);
    const observed = error;
    try {
      stream.close();
    } catch {
      /* A timed-out reader has already closed. */
    }
    await pending;
    expect(observed).toBeInstanceOf(Error);
    expect((observed as Error).message).toMatch(/timed out/i);
  } finally {
    vi.useRealTimers();
  }
});

it("rejects excess entries and oversized IDs rather than truncating them", () => {
  const entries = Array.from({ length: 2_000 }, (_, i) => ({ id: `m-${i}` }));
  expect(parseModelList({ data: entries })).toHaveLength(2_000);
  expect(() => parseModelList({ data: [...entries, { id: "last" }] })).toThrow(
    /2,000/,
  );
  expect(parseModelList({ data: [{ id: "a".repeat(1_024) }] })).toHaveLength(1);
  expect(() => parseModelList({ data: [{ id: "a".repeat(1_025) }] })).toThrow(
    /1,024/,
  );
});

it("counts actual body bytes even when content-length lies, including error bodies", async () => {
  for (const status of [200, 500]) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      },
    });
    await expect(
      listEndpointModels(
        "https://x/v1",
        null,
        async () =>
          new Response(body, { status, headers: { "content-length": "1" } }),
      ),
    ).rejects.toThrow(/4 MiB/);
  }
});

it("preserves UTF-8 characters split between chunks at the exact byte limit", async () => {
  const json = new TextEncoder().encode('{"data":[{"id":"日本"}]}');
  const padding = new Uint8Array(4 * 1024 * 1024 - json.length).fill(32);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of json) controller.enqueue(new Uint8Array([byte]));
      controller.enqueue(padding);
      controller.close();
    },
  });
  await expect(
    listEndpointModels("https://x/v1", null, async () => new Response(body)),
  ).resolves.toEqual(["日本"]);
});

it("cancels a stalled body when its caller aborts and cleans up its deadline", async () => {
  vi.useFakeTimers();
  const owner = new AbortController();
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }));
  const pending = listEndpointModels(
    "https://x/v1",
    null,
    async () => response,
    owner.signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await Promise.resolve();
  owner.abort();
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it("times out before headers and cancels a response that arrives afterwards", async () => {
  vi.useFakeTimers();
  let resolve!: (response: Response) => void;
  const fetchImpl = vi.fn(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const pending = listEndpointModels("https://x/v1", null, fetchImpl);
  const rejected = expect(pending).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  const cancel = vi.fn();
  resolve(new Response(new ReadableStream({ cancel })));
  await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
