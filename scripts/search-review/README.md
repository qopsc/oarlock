# Historical editor regex and pending Vim reproduction

This fixture recorded the review 100 baseline before editor worker isolation.
Review 101 now refuses regex in MatchScan and routes the normal editor UI through
a bounded worker; the direct CodeMirror cursor remains an unsafe primitive. This fixture
uses the production MatchScan and CodeMirror cursor on a roughly 1 KiB document
(32 lines of 34 `a` characters followed by `!`). Both paths exceed a two-second
external deadline for `(a+)+$`. Even an already-expired MatchScan slice cannot
interrupt a cursor evaluation.

Do not run the child fixture without an external deadline. This safe launcher
kills each reproduction after two seconds:

```sh
python3 - <<'PY'
import subprocess
for mode in ('counter', 'cursor'):
    try:
        result = subprocess.run(
            ['bun', 'scripts/search-review/editor-regex-probe.mjs', mode],
            capture_output=True, text=True, timeout=2)
        print(mode, result.returncode, result.stdout, result.stderr)
    except subprocess.TimeoutExpired as error:
        print(mode, 'TIMED OUT after 2 seconds', error.stdout)
PY
```

The old MatchScan reproduction now returns without evaluating regex; direct cursor
execution still demonstrates why the UI must use the worker boundary. Current
passing tests and webview fixtures live in scripts/editor-search.

vim-regex-probe.mjs retains the pinned upstream synchronous Vim reproduction.
Run it with the same external subprocess deadline. Current worker, ownership and
compatibility checks for the approved local forks live in scripts/vim-review.

The formerly held Ubuntu-to-Debian project-search regression is now enabled and
passes in src/modules/command-palette/hooks/useAsyncQuery.test.ts. Project search
carries an environment/space/root owner and cancels exact native requests.
