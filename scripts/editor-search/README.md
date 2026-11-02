# Bounded editor regex validation

The editor Find/Replace panel, search keymap, highlights and counter share a
worker result. The UI retains only query data and bounded match spans; CodeMirror
receives an empty literal query while regex mode is active. External regex query
effects are intercepted before view plugins update. Literal search is unchanged.
Vim's separate adapter now uses the maintained local forks described in
`scripts/vim-review/README.md`. Both paths share the four-worker budget.

Limits: four active editor workers per page; a 4,096-code-unit pattern/replacement;
8,388,608 UTF-16 document/output units (16 MiB); 10,000 matches; ten seconds total
per worker, checked at delivery too. Exceeding a limit produces an error and Retry,
without partial replacement. Select All retains CodeMirror's 1,000-selection cap.
Each scan owns its exact document and query; queued replacement also retains the
selection and rechecks read-only state. Closing/hiding/destroying the editor or
changing its query/document discards obsolete work. Automatic starts wait 100 ms;
explicit navigation and Retry start immediately. No idle workers remain.

Run the real-worker regression (with an outer deadline in the frontend suite):

```sh
bun run test src/modules/editor/search
```

Run the actual WKWebView integration fixture on macOS:

```sh
bun run vite build --config scripts/editor-search/vite.config.ts
swiftc -module-cache-path /tmp/oarlock-editor-regex-swift-cache scripts/terminal-search/host.swift -o /tmp/oarlock-editor-regex-host
/tmp/oarlock-editor-regex-host /tmp/oarlock-editor-regex-probe "$PWD/src-tauri/tauri.conf.json" 650 500
```

The test verifies hostile-pattern termination with a responsive UI, worker
recovery, real CodeMirror highlights and Replace All, and external query
interception under tauri://localhost and the production CSP. It uses an isolated,
nonpersistent webview and no user settings/files. The larger window is needed to
keep the editor viewport visible below the search panel. This is not full Tauri
application certification or validation of Windows/Linux webviews.
