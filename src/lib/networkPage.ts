/** Native delivers the generation after the new document has loaded. Never
 * query a replacement token from an old page's queued IPC command. */
export function networkPage(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const page = () =>
    (window as Window & { __OARLOCK_NETWORK_PAGE__?: string })
      .__OARLOCK_NETWORK_PAGE__;
  const current = page();
  if (current) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("oarlock:network-page", ready);
      signal.removeEventListener("abort", abort);
    };
    const ready = () => {
      const token = page();
      if (!token) return;
      cleanup();
      resolve(token);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "Native network page initialization timed out. Reload the window and try again.",
        ),
      );
    }, 30_000);
    window.addEventListener("oarlock:network-page", ready);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else ready();
  });
}
