import { readFileSync } from "node:fs";

function read(path) {
  const line = readFileSync(path, "utf8")
    .split("\n")
    .find((line) => line.startsWith('{"passed"'));
  const result = JSON.parse(line || "null");
  if (
    !result?.passed ||
    result.total !== 715 ||
    result.success + result.failures.length !== result.total
  ) {
    throw Error(`Incomplete corpus: ${path}`);
  }
  return result;
}

const baseline = read(process.argv[2]);
const fork = read(process.argv[3]);
const known = new Set(baseline.failures.map(({ name }) => name));
const added = fork.failures.filter(({ name }) => !known.has(name));
console.log(
  JSON.stringify(
    {
      total: fork.total,
      baselinePassed: baseline.success,
      forkPassed: fork.success,
      addedFailures: added,
      remainingFailures: fork.failures.length,
    },
    null,
    2,
  ),
);
process.exitCode = added.length ? 1 : 0;
