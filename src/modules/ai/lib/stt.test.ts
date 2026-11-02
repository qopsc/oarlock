import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_PROVIDER_KEYS, type ProviderKeys } from "./keyring";

const openaiSdk = vi.hoisted(() => {
  const transcription = vi.fn();
  const createOpenAI = vi.fn(() => ({ transcription }));
  return { createOpenAI, transcription };
});

vi.mock("@ai-sdk/openai", () => ({ createOpenAI: openaiSdk.createOpenAI }));

const aiSdk = vi.hoisted(() => ({
  transcribe: vi.fn(async () => ({ text: "hello world" })),
}));

vi.mock("ai", () => ({ transcribe: aiSdk.transcribe }));

import { transcribeAudio } from "./stt";

const fetchMock = vi.fn();
const blob = new Blob(["audio-bytes"], { type: "audio/webm" });
const keys = (partial: Partial<ProviderKeys>): ProviderKeys => ({
  ...EMPTY_PROVIDER_KEYS,
  ...partial,
});

class FakeAudioContext {
  decodeAudioData() {
    return Promise.resolve({
      length: 2,
      sampleRate: 44100,
      numberOfChannels: 1,
      getChannelData: () => Float32Array.from([0.5, -0.5]),
    });
  }
  close() {}
}

function stubWhisperHappyPath(response = "transcript") {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  fetchMock.mockImplementation(() => new Response(response, { status: 200 }));
}

describe("speech-to-text providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    openaiSdk.createOpenAI.mockClear();
    openaiSdk.transcription.mockClear();
    aiSdk.transcribe.mockClear();
  });

  it("refuses a non-loopback whisper.cpp URL before any request", async () => {
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      transcribeAudio(blob, "whispercpp", EMPTY_PROVIDER_KEYS, {
        whispercppBaseURL: "http://192.168.1.10:8080",
      }),
    ).rejects.toThrow(/loopback/);
    await expect(
      transcribeAudio(blob, "whispercpp", EMPTY_PROVIDER_KEYS, {
        whispercppBaseURL: "http://example.com",
      }),
    ).rejects.toThrow(/loopback/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an unparseable whisper.cpp URL", async () => {
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      transcribeAudio(blob, "whispercpp", EMPTY_PROVIDER_KEYS, {
        whispercppBaseURL: "not-a-url",
      }),
    ).rejects.toThrow(/Invalid Whisper.cpp URL/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts loopback forms and strips the trailing slash from the base URL", async () => {
    stubWhisperHappyPath();

    const bases = [
      "http://localhost:8080/",
      "http://127.0.0.1:8080///",
      "http://[::1]:8080/",
    ];
    for (const baseURL of bases) {
      await expect(
        transcribeAudio(blob, "whispercpp", EMPTY_PROVIDER_KEYS, {
          whispercppBaseURL: baseURL,
        }),
      ).resolves.toBe("transcript");
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.stringMatching(
          /^http:\/\/(localhost|\[::1\]|127\.0\.0\.1):8080\/inference$/,
        ),
        expect.objectContaining({ method: "POST" }),
      );
    }
  });

  it("defaults the whisper.cpp endpoint to local port 8080", async () => {
    stubWhisperHappyPath("ok");

    await expect(
      transcribeAudio(blob, "whispercpp", EMPTY_PROVIDER_KEYS),
    ).resolves.toBe("ok");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/inference",
      expect.anything(),
    );
  });

  it("keeps speech from the right channel when preparing offline audio", async () => {
    stubWhisperHappyPath();
    vi.stubGlobal(
      "AudioContext",
      class {
        decodeAudioData() {
          return Promise.resolve({
            length: 2,
            sampleRate: 48000,
            numberOfChannels: 2,
            getChannelData: (channel: number) =>
              Float32Array.from(channel === 0 ? [0, 0] : [1, -1]),
          });
        }
        close() {}
      },
    );
    await transcribeAudio(blob, "whispercpp", EMPTY_PROVIDER_KEYS);
    const form = fetchMock.mock.calls[0][1].body as FormData;
    const wav = new DataView(await (form.get("file") as Blob).arrayBuffer());
    expect(wav.getUint16(22, true)).toBe(1);
    expect(wav.getUint32(24, true)).toBe(48000);
    expect(wav.getInt16(44, true)).toBe(16383);
    expect(wav.getInt16(46, true)).toBe(-16384);
  });

  it("requires an OpenAI key before touching the network", async () => {
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      transcribeAudio(blob, "openai", EMPTY_PROVIDER_KEYS),
    ).rejects.toThrow(/OpenAI API key is not configured/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes OpenAI dictation through the AI SDK transcription path", async () => {
    const transcriptionModel = { modelId: "whisper-1" };
    openaiSdk.transcription.mockReturnValue(transcriptionModel);

    await expect(
      transcribeAudio(blob, "openai", keys({ openai: "sk-openai" })),
    ).resolves.toBe("hello world");

    expect(openaiSdk.createOpenAI).toHaveBeenCalledWith({
      apiKey: "sk-openai",
    });
    expect(aiSdk.transcribe).toHaveBeenCalledWith({
      abortSignal: undefined,
      model: transcriptionModel,
      audio: expect.any(Uint8Array),
    });
  });

  it("requires a Groq key before touching the network", async () => {
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      transcribeAudio(blob, "groq", EMPTY_PROVIDER_KEYS),
    ).rejects.toThrow(/Groq API key is not configured/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts Groq dictation with the bearer key and selected model", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response("groq transcript", { status: 200 }),
    );

    await expect(
      transcribeAudio(blob, "groq", keys({ groq: "gsk-groq" }), {
        groqSttModel: "whisper-small",
      }),
    ).resolves.toBe("groq transcript");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(init.headers.Authorization).toBe("Bearer gsk-groq");
    expect((init.body as FormData).get("model")).toBe("whisper-small");
  });

  it("defaults the Groq model when none is configured", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));

    await transcribeAudio(blob, "groq", keys({ groq: "gsk-groq" }));

    const [, init] = fetchMock.mock.calls[0];
    expect((init.body as FormData).get("model")).toBe("whisper-large-v3-turbo");
  });

  it("surfaces the upstream status and body on Groq failures", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      new Response("quota exceeded", { status: 429 }),
    );

    await expect(
      transcribeAudio(blob, "groq", keys({ groq: "gsk-groq" })),
    ).rejects.toThrow(/STT request failed \(429\): quota exceeded/);
  });
});

describe("transcription cancellation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    fetchMock.mockReset();
    aiSdk.transcribe.mockClear();
  });
  it.each(["openai", "groq", "whispercpp"] as const)(
    "rejects already-cancelled %s work before network or decoding",
    async (provider) => {
      const controller = new AbortController();
      controller.abort();
      vi.stubGlobal("fetch", fetchMock);
      const context = vi.fn();
      vi.stubGlobal("AudioContext", context);
      await expect(
        transcribeAudio(blob, provider, keys({ openai: "key", groq: "key" }), {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(context).not.toHaveBeenCalled();
      expect(aiSdk.transcribe).not.toHaveBeenCalled();
    },
  );
  it("passes the owning signal to OpenAI transcription", async () => {
    const controller = new AbortController();
    await transcribeAudio(blob, "openai", keys({ openai: "key" }), {
      signal: controller.signal,
    });
    expect(aiSdk.transcribe).toHaveBeenLastCalledWith(
      expect.objectContaining({ abortSignal: controller.signal }),
    );
  });
  it("aborts a REST response body after headers have arrived", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", fetchMock);
    let reading!: () => void;
    const started = new Promise<void>((r) => {
      reading = r;
    });
    fetchMock.mockImplementation(async (_url, init: RequestInit) => ({
      ok: true,
      text: () =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
          reading();
        }),
    }));
    const request = transcribeAudio(blob, "groq", keys({ groq: "key" }), {
      signal: controller.signal,
    });
    const rejected = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await started;
    controller.abort();
    await rejected;
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(
      true,
    );
  });
  it("keeps the timeout armed while reading a stalled response body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async (_url, init: RequestInit) => ({
      ok: true,
      text: () =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          ),
        ),
    }));
    const request = transcribeAudio(blob, "groq", keys({ groq: "key" }));
    const rejected = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels WAV decoding and never uploads its late output", async () => {
    const controller = new AbortController();
    let decoded!: (value: object) => void;
    let started!: () => void;
    const decoding = new Promise<void>((r) => {
      started = r;
    });
    const close = vi.fn(async () => {});
    vi.stubGlobal(
      "AudioContext",
      class {
        close = close;
        decodeAudioData() {
          started();
          return new Promise((r) => {
            decoded = r;
          });
        }
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = transcribeAudio(blob, "whispercpp", EMPTY_PROVIDER_KEYS, {
      signal: controller.signal,
    });
    const rejected = expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    await decoding;
    controller.abort();
    expect(close).toHaveBeenCalledOnce();
    decoded({});
    await rejected;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});

it("refuses redirects from the offline transcription endpoint", async () => {
  const { createServer } = await import("node:http");
  let forwarded = 0;
  const target = createServer((_request, response) => {
    forwarded++;
    response.end("forwarded audio");
  });
  const redirect = createServer((_request, response) => {
    const address = target.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test port");
    response.writeHead(307, {
      Location: `http://127.0.0.1:${address.port}/upload`,
    });
    response.end();
  });
  try {
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => redirect.listen(0, "127.0.0.1", r));
    const address = redirect.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test port");
    vi.stubGlobal("AudioContext", FakeAudioContext);
    await expect(
      transcribeAudio(blob, "whispercpp", EMPTY_PROVIDER_KEYS, {
        whispercppBaseURL: `http://127.0.0.1:${address.port}`,
      }),
    ).rejects.toThrow();
    expect(forwarded).toBe(0);
  } finally {
    vi.unstubAllGlobals();
    target.closeAllConnections();
    redirect.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => target.close(() => r())),
      new Promise<void>((r) => redirect.close(() => r())),
    ]);
  }
});

it("does not decode audio after cancellation during the blob read", async () => {
  let read!: (data: ArrayBuffer) => void;
  const audio = new Blob(["audio"]);
  vi.spyOn(audio, "arrayBuffer").mockReturnValue(
    new Promise((r) => {
      read = r;
    }),
  );
  const decode = vi.fn(async () => ({
    length: 1,
    sampleRate: 16000,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(1),
  }));
  vi.stubGlobal(
    "AudioContext",
    class {
      decodeAudioData = decode;
      close() {
        return Promise.resolve();
      }
    },
  );
  const controller = new AbortController();
  try {
    const pending = transcribeAudio(audio, "whispercpp", EMPTY_PROVIDER_KEYS, {
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    read(new ArrayBuffer(0));
    await rejection;
    expect(decode).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
