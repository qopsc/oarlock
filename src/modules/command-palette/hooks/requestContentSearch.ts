import { networkPage } from "@/lib/networkPage";
import { Channel, invoke } from "@tauri-apps/api/core";

export type GrepResponse = {
  hits: ContentHit[];
  truncated: boolean;
  cancelled: boolean;
};
type Reply = { Ok: GrepResponse } | { Err: string };
import type { ContentHit, ContentSearchChannel } from "./useContentSearch";
import type { WorkspaceEnv } from "@/modules/workspace";

/** Registration is acknowledged separately from completion, so cancellation
 * that overtakes admission is retried immediately after the acknowledgment. */
export async function requestContentSearch(
  args: {
    pattern: string;
    root: string;
    workspace: WorkspaceEnv;
    channel: ContentSearchChannel;
    maxResults: number;
  },
  signal: AbortSignal,
): Promise<GrepResponse> {
  signal.throwIfAborted();
  const pageGeneration = await networkPage(signal);
  signal.throwIfAborted();
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const channel = new Channel<Reply>();
    let closed = false;
    let cancelled = false;
    const cancelNative = () =>
      invoke("fs_grep_cancel", { requestId, pageGeneration }).catch(() => {});
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
    void invoke("fs_grep_interactive", {
      ...args,
      requestId,
      pageGeneration,
      onEvent: channel,
    }).then(() => {
      if (cancelled) void cancelNative();
    }, fail);
  });
}
