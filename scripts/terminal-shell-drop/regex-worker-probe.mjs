// Exercise the production UI-side engine and real worker. A subprocess caller
// can bound this probe even if a regression puts regex execution on its thread.
import assert from "node:assert/strict";
import { RegexTerminalSearch } from "../../src/modules/terminal/ghostty/search/RegexTerminalSearch.ts";
import { createRegexRunner } from "../../src/modules/terminal/ghostty/search/regexWorkerClient.ts";

let ticks = 0;
const heartbeat = setInterval(() => ticks++, 10);
let finish;
const done = new Promise((resolve) => { finish = resolve; });
const engine = new RegexTerminalSearch({
  rows: 128, revision: () => 1, scrollPosition: () => ({ history: 0 }),
  readCellLine: () => [..."a".repeat(30), "!"],
}, () => {
  if (engine.status().complete) finish();
  else engine.step(128);
});
const started = performance.now();
try {
  engine.setQuery("(a+)+$");
  engine.step(128);
  await done;
  assert.match(engine.failure(), /timed out/);
  assert.ok(ticks > 0, "Main event loop did not progress");
} finally {
  engine.dispose();
  clearInterval(heartbeat);
}
const next = createRegexRunner();
try {
  assert.deepEqual(await next.run({ pattern: "x", lines: [["x"]], firstLine: 0, limit: 1 }, 1000),
    [{ line: 0, startColumn: 0, endColumn: 1 }]);
} finally { next.dispose(); }
console.log(JSON.stringify({ deadlinePassed: true, responsiveTicks: ticks, elapsedMs: Math.round(performance.now() - started), recoveryPassed: true }));
