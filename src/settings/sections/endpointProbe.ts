import { networkPage } from "@/lib/networkPage";
import { Channel, invoke } from "@tauri-apps/api/core";

type Reply = { Ok: number } | { Err: string };

/** Registration is acknowledged separately from completion, so cancellation
 * that overtakes admission is retried immediately after the acknowledgment. */
export async function requestEndpointProbe(
  baseUrl: string,
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  const pageGeneration = await networkPage(signal);
  signal.throwIfAborted();
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const channel = new Channel<Reply>();
    let closed = false;
    let cancelled = false;
    const cancelNative = () =>
      invoke("lm_ping_cancel", { requestId, pageGeneration }).catch(() => {});
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      channel.onmessage = () => {};
    };
    const fail = (error: unknown) => {
      if (closed) return;
      closed = true;
      cleanup();
      reject(error);
    };
    const abort = () => {
      if (closed) return;
      cancelled = true;
      fail(signal.reason);
      void cancelNative();
    };
    channel.onmessage = (reply) => {
      if (closed) return;
      if ("Err" in reply) {
        fail(new Error(reply.Err));
      } else {
        closed = true;
        cleanup();
        resolve(reply.Ok);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    void invoke("lm_ping", {
      baseUrl,
      requestId,
      pageGeneration,
      onEvent: channel,
    }).then(() => {
      if (cancelled) void cancelNative();
    }, fail);
  });
}
