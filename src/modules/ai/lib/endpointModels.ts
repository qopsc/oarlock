import { formatAiError } from "./errors";
import { createProxyFetch } from "./proxyFetch";

// Local servers and custom endpoints are reached through the native proxy, as
// their chat requests are (no webview CORS, private networks allowed).
const endpointFetch = createProxyFetch({ allowPrivateNetwork: true });
export const MODEL_LIST_MAX_BYTES = 4 * 1024 * 1024;
export const MODEL_LIST_MAX_ENTRIES = 2_000;
export const MODEL_ID_MAX_LENGTH = 1_024;
export const MODEL_LIST_TIMEOUT_MS = 30_000;

async function readModelList(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const tooLarge = () =>
    new Error("The server's model list exceeds the 4 MiB response limit.");
  const advertised = response.headers.get("content-length");
  if (
    advertised &&
    /^\d+$/.test(advertised) &&
    Number(advertised) > MODEL_LIST_MAX_BYTES
  ) {
    void response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  const text: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MODEL_LIST_MAX_BYTES) {
        cancel();
        throw tooLarge();
      }
      text.push(decoder.decode(chunk.value, { stream: true }));
    }
    text.push(decoder.decode());
    return text.join("");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** The model ids an OpenAI-compatible server lists at `GET <base>/models`
 *  (LM Studio, Ollama, MLX, vLLM, gateways), sorted and without duplicates. */
export async function listEndpointModels(
  baseURL: string,
  apiKey?: string | null,
  fetchImpl: typeof fetch = endpointFetch,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error("Model discovery timed out after 30 seconds."),
      ),
    MODEL_LIST_TIMEOUT_MS,
  );
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const operation = (async () => {
      const url = `${baseURL.trim().replace(/\/+$/, "")}/models`;
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        controller.signal.throwIfAborted();
      }
      const text = await readModelList(response, controller.signal);
      controller.signal.throwIfAborted();
      if (!response.ok)
        throw new Error(`HTTP ${response.status}: ${formatAiError(text)}`);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error("The server's model list is not JSON.");
      }
      return parseModelList(body);
    })();
    return await Promise.race([operation, cancelled]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

export function parseModelList(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new Error("The server's model list is not in the OpenAI format.");
  }
  if (data.length > MODEL_LIST_MAX_ENTRIES) {
    throw new Error("The server's model list exceeds the 2,000-entry limit.");
  }
  const ids = new Set<string>();
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === "string") {
      if (id.length > MODEL_ID_MAX_LENGTH)
        throw new Error("A model ID exceeds the 1,024-character limit.");
      if (id.trim()) ids.add(id.trim());
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}
