import { createRegexRunner } from "../../src/modules/terminal/ghostty/search/regexWorkerClient";

async function probe() {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const worker = createRegexRunner();
  let timedOut = false;
  try {
    await worker.run({ pattern: "(a+)+$", lines: Array.from({ length: 128 }, () => [..."a".repeat(30), "!"]), firstLine: 0, limit: 10000 }, 200);
  } catch (error) { timedOut = String(error).includes("timed out"); }
  finally { worker.dispose(); clearInterval(timer); }
  if (!timedOut || !ticks) throw new Error(`Unresponsive or unexpected result: timeout=${timedOut}, ticks=${ticks}`);
  const next = createRegexRunner();
  try {
    const matches = await next.run({ pattern: "日b", lines: [["日", "", "b"]], firstLine: 0, limit: 1 }, 1000);
    if (matches.length !== 1 || matches[0].endColumn !== 3) throw new Error("Worker recovery/wide-cell matching failed");
  } finally { next.dispose(); }
  return { passed: true, ticks, scheme: location.protocol };
}

void probe().then(report, (error) => report({ passed: false, error: String(error) }));
function report(value: object) {
  const bridge = (window as unknown as { webkit?: { messageHandlers: { out: { postMessage: (value: string) => void } } } }).webkit;
  bridge?.messageHandlers.out.postMessage(JSON.stringify(value));
  document.body.textContent = JSON.stringify(value);
}
