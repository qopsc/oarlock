#!/bin/bash
# Export only the requested committed revision for an app-lab benchmark.
# The revision must already contain the bench instrumentation; current edits,
# dependencies and sidecar binaries are never overlaid onto the snapshot.
#
#   export-tree.sh DEST [REV]        REV defaults to HEAD
#
# Install the snapshot's locked dependencies and build its own CLI before use.
set -euo pipefail
dest="${1:?usage: export-tree.sh DEST [REV]}"
rev="${2:-HEAD}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
commit="$(git -C "$repo" rev-parse --verify --quiet --end-of-options "${rev}^{commit}")" || {
  echo "Cannot resolve revision: $rev" >&2
  exit 1
}
[ -e "$dest" ] && { echo "$dest already exists" >&2; exit 1; }
mkdir -p "$(dirname "$dest")"
mkdir "$dest"
git -C "$repo" archive "$commit" | tar -x -C "$dest"
if [ ! -f "$dest/src/bench/driver.ts" ] || [ ! -f "$dest/src-tauri/src/modules/bench.rs" ] ||
   ! grep -Eq '^[[:space:]]*bench[[:space:]]*=' "$dest/src-tauri/Cargo.toml"; then
  echo "Revision $rev does not contain app-lab instrumentation; use an instrumented revision." >&2
  exit 1
fi
printf 'Exported %s to %s. Install its locked dependencies and build its CLI before benchmarking:\n' "$commit" "$dest"
printf '  (cd %q && bun install --frozen-lockfile && bun run build:cli)\n' "$dest"
