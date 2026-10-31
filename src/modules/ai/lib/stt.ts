import { encodeMonoWav } from "./wav";
import { readyKey } from "@/modules/ai/lib/credentialState";
import type { ProviderKeys } from "./keyring";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const STT_TIMEOUT_GROQ_MS = 30_000;
const STT_TIMEOUT_WHISPERCPP_MS = 180_000;

async function fetchTextWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    controller.signal.throwIfAborted();
    const text = await response.text();
    controller.signal.throwIfAborted();
    if (!response.ok)
      throw new Error(
        `STT request failed (${response.status}): ${text || response.statusText}`,
      );
    return text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function transcribeOpenAI(
  blob: Blob,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const [{ createOpenAI }, { transcribe }] = await Promise.all([
    import("@ai-sdk/openai"),
    import("ai"),
  ]);
  signal?.throwIfAborted();
  const openai = createOpenAI({ apiKey });
  const buf = new Uint8Array(await blob.arrayBuffer());
  signal?.throwIfAborted();
  const { text } = await transcribe({
    abortSignal: signal,
    model: openai.transcription("whisper-1"),
    audio: buf,
  });
  signal?.throwIfAborted();
  return text;
}

async function transcribeViaRest(
  baseURL: string,
  blob: Blob,
  apiKey: string | null,
  model: string,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append("file", blob, "audio.webm");
  form.append("model", model);
  form.append("response_format", "text");

  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  return fetchTextWithTimeout(
    `${baseURL}/audio/transcriptions`,
    {
      method: "POST",
      headers,
      body: form,
    },
    STT_TIMEOUT_GROQ_MS,
    signal,
  );
}

async function toWav(blob: Blob, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const ctx = new AudioContext();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void ctx.close()?.catch(() => {});
  };
  signal?.addEventListener("abort", close, { once: true });
  try {
    const audio = await blob.arrayBuffer();
    signal?.throwIfAborted();
    const buf = await ctx.decodeAudioData(audio);
    signal?.throwIfAborted();
    return encodeMonoWav(buf);
  } finally {
    signal?.removeEventListener("abort", close);
    close();
  }
}

async function transcribeWhisperCpp(
  baseURL: string,
  blob: Blob,
  signal?: AbortSignal,
): Promise<string> {
  const wav = await toWav(blob, signal);
  const form = new FormData();
  form.append("file", wav, "audio.wav");
  form.append("response_format", "text");

  return fetchTextWithTimeout(
    `${baseURL}/inference`,
    {
      method: "POST",
      redirect: "error", // Offline audio must not be forwarded to another host.
      body: form,
    },
    STT_TIMEOUT_WHISPERCPP_MS,
    signal,
  );
}

// Offline provider: never POST recorded audio to a non-loopback host.
function assertLoopbackUrl(baseURL: string): void {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error(`Invalid Whisper.cpp URL: ${baseURL}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  if (!loopback) {
    throw new Error(
      "Whisper.cpp must run on a loopback address (localhost or 127.x.x.x) to keep transcription local.",
    );
  }
}

export type SttOptions = {
  signal?: AbortSignal;
  groqSttModel?: string;
  whispercppBaseURL?: string;
};

export async function transcribeAudio(
  blob: Blob,
  provider: import("../config").SttProvider,
  apiKeys: ProviderKeys,
  options: SttOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  switch (provider) {
    case "openai": {
      const key = readyKey(apiKeys.openai);
      if (!key) throw new Error("OpenAI API key is not configured");
      return transcribeOpenAI(blob, key, options.signal);
    }
    case "groq": {
      const key = readyKey(apiKeys.groq);
      if (!key) throw new Error("Groq API key is not configured");
      const model = options.groqSttModel || "whisper-large-v3-turbo";
      return transcribeViaRest(GROQ_BASE_URL, blob, key, model, options.signal);
    }
    case "whispercpp": {
      const baseURL =
        options.whispercppBaseURL?.replace(/\/+$/, "") ||
        "http://127.0.0.1:8080";
      assertLoopbackUrl(baseURL);
      return transcribeWhisperCpp(baseURL, blob, options.signal);
    }
  }
}
