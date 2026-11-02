import { networkPage } from "@/lib/networkPage";
import { Channel, invoke } from "@tauri-apps/api/core";

/** Native acknowledges registration before downloading. A cancellation that
 * overtakes registration is repeated after that acknowledgment, as in AI fetch. */
export async function requestRemoteImage(
  url: string,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted();
  const pageGeneration = await networkPage(signal);
  signal.throwIfAborted();
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const channel = new Channel<ArrayBuffer>();
    let closed = false;
    let cancelled = false;
    const cancelNative = () =>
      invoke("markdown_remote_image_cancel", {
        requestId,
        pageGeneration,
      }).catch(() => {});
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      channel.onmessage = () => {};
    };
    const fail = (error: unknown, cancel = false) => {
      if (closed) return;
      closed = true;
      cancelled = cancel;
      cleanup();
      reject(error);
      if (cancel) void cancelNative();
    };
    const abort = () => fail(signal.reason, true);
    channel.onmessage = (buffer) => {
      if (closed) return;
      const bytes = new Uint8Array(buffer);
      if (bytes[0] === 1) {
        fail(new Error(new TextDecoder().decode(bytes.subarray(1))));
      } else if (bytes[0] === 0 && bytes.length > 1) {
        closed = true;
        cleanup();
        resolve(bytes.subarray(1));
      } else {
        fail(new Error("Invalid native image response"), true);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    void invoke("markdown_remote_image", {
      url,
      requestId,
      pageGeneration,
      onEvent: channel,
    }).then(
      () => {
        if (cancelled) void cancelNative();
      },
      (error) =>
        fail(error instanceof Error ? error : new Error(String(error))),
    );
  });
}
