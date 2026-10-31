/** Release run-owned resources on completion, failure, consumer cancellation or Stop. */
export function ownedStream<T>(
  source: ReadableStream<T>,
  release: (reason: "complete" | "error" | "cancel" | "abort") => Promise<void>,
  signal?: AbortSignal,
  observe?: (chunk: T) => void,
): ReadableStream<T> {
  const reader = source.getReader();
  let cleanup: Promise<void> | undefined;
  const finish = (reason: "complete" | "error" | "cancel" | "abort") => {
    signal?.removeEventListener("abort", aborted);
    cleanup ??= Promise.resolve().then(() => release(reason));
    return cleanup;
  };
  const aborted = () => {
    void finish("abort").catch((error) =>
      console.warn("Run cleanup failed", error),
    );
  };
  signal?.addEventListener("abort", aborted, { once: true });
  if (signal?.aborted) aborted();
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await finish("complete");
          controller.close();
        } else {
          observe?.(next.value);
          controller.enqueue(next.value);
        }
      } catch (error) {
        await finish("error").catch(() => {});
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await finish("cancel");
      }
    },
  });
}
