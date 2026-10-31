import {
  validateRegexBatch,
  type RegexBatch,
  type RegexMatch,
  type RegexReply,
} from "./regexProtocol";

export interface RegexRunner {
  run(batch: RegexBatch, deadlineMs: number): Promise<RegexMatch[]>;
  dispose(): void;
}
type WorkerPort = Pick<
  Worker,
  "postMessage" | "terminate" | "onmessage" | "onerror" | "onmessageerror"
>;
let workers = 0;
const MAX_WORKERS = 4;

/** One worker per active scan, one batch in flight; no worker exists while idle. */
export function createRegexRunner(
  factory: () => WorkerPort = () =>
    new Worker(new URL("./regexWorker.ts", import.meta.url), {
      type: "module",
    }),
): RegexRunner {
  if (workers >= MAX_WORKERS)
    throw new Error(
      "Too many regex searches are active. Close another search and retry.",
    );
  const worker = factory();
  workers++;
  let disposed = false;
  let sequence = 0;
  let pending: {
    id: number;
    deadline: number;
    batch: RegexBatch;
    resolve: (matches: RegexMatch[]) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    workers--;
    worker.onmessage = worker.onerror = worker.onmessageerror = null;
    worker.terminate();
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Regex search cancelled."));
      pending = null;
    }
  };
  const fail = (message: string) => {
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      pending = null;
    }
    dispose();
  };
  worker.onerror = (event) => {
    event.preventDefault?.();
    fail("Regex worker failed. Retry the search.");
  };
  worker.onmessageerror = () =>
    fail("Regex worker returned unreadable data. Retry the search.");
  worker.onmessage = (event: MessageEvent<RegexReply>) => {
    const current = pending;
    if (disposed || !current || event.data.id !== current.id) return;
    if (performance.now() >= current.deadline) {
      fail("Regex search timed out. Refine the pattern or use literal search.");
      return;
    }
    const { matches, error } = event.data;
    if (error) {
      fail(error);
      return;
    }
    if (
      !Array.isArray(matches) ||
      matches.length > current.batch.limit ||
      matches.some((match) => {
        const row = current.batch.lines[match.line - current.batch.firstLine];
        return (
          !row ||
          !Number.isInteger(match.line) ||
          !Number.isInteger(match.startColumn) ||
          !Number.isInteger(match.endColumn) ||
          match.startColumn < 0 ||
          match.endColumn <= match.startColumn ||
          match.endColumn > row.length
        );
      })
    ) {
      fail("Regex worker returned invalid matches.");
      return;
    }
    clearTimeout(current.timer);
    pending = null;
    current.resolve(matches);
  };
  return {
    run(batch, deadlineMs) {
      if (disposed || pending)
        return Promise.reject(new Error("Regex worker is unavailable."));
      try {
        validateRegexBatch(batch);
      } catch (error) {
        dispose();
        return Promise.reject(error);
      }
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const duration = Number.isFinite(deadlineMs)
          ? Math.max(1, Math.min(1000, deadlineMs))
          : 1;
        const deadline = performance.now() + duration;
        const timer = setTimeout(
          () =>
            fail(
              "Regex search timed out. Refine the pattern or use literal search.",
            ),
          duration,
        );
        pending = { id, deadline, batch, resolve, reject, timer };
        try {
          worker.postMessage({ id, batch });
        } catch {
          fail("Could not send terminal text to the regex worker.");
        }
      });
    },
    dispose,
  };
}
