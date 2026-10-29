# Terminal regex worker probe

`bun scripts/terminal-shell-drop/regex-worker-probe.mjs` runs the production
search engine with a hostile pattern in a real Bun worker. It verifies a responsive
caller, worker termination at the deadline, and successful subsequent search. The
frontend test suite runs it in a subprocess with an independent deadline.

To verify packaged worker loading in macOS WKWebView:

```sh
bun run vite build --config scripts/terminal-search/vite.config.ts
swiftc -module-cache-path /tmp/oarlock-regex-swift-cache scripts/terminal-search/host.swift -o /tmp/oarlock-regex-host
/tmp/oarlock-regex-host /tmp/oarlock-regex-probe "$PWD/src-tauri/tauri.conf.json"
```

The fixture uses `tauri://localhost`, the application's production CSP, and a
nonpersistent website data store. It opens a small test window, reports JSON,
then exits. It does not access user settings, files, terminal sessions or clipboard.
This verifies WKWebView loading and execution, not the entire Tauri application
or Windows/Linux webviews.

Current limits: four active workers per page; one batch per search; 128 rows,
65,536 cells and 131,072 UTF-16 code units per batch; 4,096 pattern code units;
8,388,608 input code units and ten seconds per scan; one second per worker batch,
including startup and delivery. Existing 10,000-match retention remains. Workers
are terminated on timeout, error, completion, cancellation or suspension. Output
bursts cancel obsolete work immediately and wait 100 ms before restarting.
