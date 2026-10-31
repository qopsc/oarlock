import { reserveRegexWorker } from "@replit/codemirror-vim/worker-budget";
import {
  MAX_MATCHES,
  MAX_TEXT_UNITS,
  validateInput,
  type RegexInput,
  type RegexMatch,
} from "./regexTypes";
export type RegexTask = { result: Promise<RegexMatch[]>; cancel: () => void };
/** No worker survives its single scan; a page never runs more than four scans. */
export function startRegex(
  input: RegexInput,
  factory = () =>
    new Worker(new URL("./regexWorker.ts", import.meta.url), {
      type: "module",
    }),
  timeout = 10_000,
): RegexTask {
  validateInput(input);
  const release = reserveRegexWorker();
  let worker: Worker;
  try {
    worker = factory();
  } catch (error) {
    release();
    throw error;
  }
  let cancel = () => {};
  const result = new Promise<RegexMatch[]>((resolve, reject) => {
    let done = false;
    const deadline = performance.now() + timeout;
    const finish = (matches?: RegexMatch[], error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      release();
      if (error) reject(new Error(error));
      else resolve(matches ?? []);
    };
    const timedOut = () =>
      finish(
        undefined,
        "Regex search timed out. Refine the pattern or use literal search.",
      );
    const timer = setTimeout(timedOut, timeout);
    cancel = () => finish(undefined, "Regex search cancelled.");
    worker.onerror = (event) => {
      event.preventDefault?.();
      finish(undefined, "Regex worker failed. Retry the search.");
    };
    worker.onmessageerror = () =>
      finish(undefined, "Regex worker returned unreadable data.");
    worker.onmessage = (event) => {
      if (done) return;
      if (performance.now() >= deadline) {
        timedOut();
        return;
      }
      const data = event.data;
      if (typeof data?.error === "string") {
        finish(undefined, data.error);
        return;
      }
      const matches = data?.matches;
      let end = 0,
        units = 0;
      if (
        !Array.isArray(matches) ||
        matches.length > MAX_MATCHES ||
        matches.some((m) => {
          if (
            !m ||
            !Number.isInteger(m.from) ||
            !Number.isInteger(m.to) ||
            m.from < end ||
            m.to < m.from ||
            m.to > input.text.length ||
            typeof m.insert !== "string"
          )
            return true;
          end = m.to;
          units += m.insert.length;
          return units > MAX_TEXT_UNITS;
        })
      ) {
        finish(undefined, "Regex worker returned invalid matches.");
        return;
      }
      finish(matches);
    };
    try {
      worker.postMessage(input);
    } catch {
      finish(undefined, "Could not start regex search.");
    }
  });
  return { result, cancel };
}
