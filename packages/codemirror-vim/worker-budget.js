// Shared with Oarlock's ordinary Find/Replace worker: four total, not four
// for each feature. A reservation costs nothing when searches are unused.
let active = 0;
export function reserveRegexWorker() {
  if (active >= 4)
    throw Error(
      "Too many editor regex searches. Close another search and retry.",
    );
  active++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      active--;
    }
  };
}
