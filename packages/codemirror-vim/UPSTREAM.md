# Oarlock CodeMirror Vim adapter fork

Pinned source: `@replit/codemirror-vim` **6.4.0**, published by
https://github.com/replit/codemirror-vim (MIT; see LICENSE).
`upstream/index.js` is the original published ESM adapter, with only its core import
redirected to the pristine local core fixture. `index.js` is the maintained app
adapter. Type declarations describe the asynchronous command return paths.

Both packages are local Bun workspaces, not patches to an installed node_modules.
No additional third-party runtime dependency is introduced.

- Search cursor evaluation and highlights run in disposable module workers using
  the same CodeMirror RegExpCursor range semantics as upstream.
- The core shares registers/macros across editor views, so suspended commands are
  serialized across views. At most 256 input entries wait; overload visibly cancels
  that editor's pending work. Ordinary synchronous keys create no worker or timer.
- A command owns its page-local editor generation, document and editing permission.
  External edits/selection changes, identity changes, hidden/destroyed views and
  Vim teardown cancel pending work. Each resumed mutation rechecks that ownership.
- Incremental prompt previews have separate cancellation behavior so replacing a
  preview does not erase a pending operator such as `d/`.
- Workers share the four-worker budget with ordinary Find/Replace. The document
  and result budgets are 16 MiB UTF-16; patterns/replacements 4,096 units; regex
  ranges/results 10,000 lines/matches; command and worker deadlines ten seconds.
- Input is ordered through resumed insert/overwrite/normal modes. Undo grouping
  spans resumed steps of a command. A macro can already have edited text when
  cancelled; cancellation preserves subsequent external edits and does not roll
  back the document over them.
- Explicit Vim viewport alignment wins over the automatic cursor reveal at the
  end of its operation, so `z<CR>`/`z-` match `zt`/`zb` after moving the cursor.
- Highlight work debounces for 100 ms, cancels superseded work and keeps no worker
  after completion. Worker documents receive incremental updates during commands.

Public handleKey, multiSelectHandleKey, handleEx and findKey results can now be
promises. Callers must await them before inspecting the resulting editor state.
The UI adapter already does this. `Vim.cancelPending(cm)` invalidates outstanding
commands when an owning document is retargeted.

See `scripts/vim-review/README.md` for actual-WebView and terminal compatibility
checks. Upstream README and license are retained for provenance; the contracts
above describe the changes in this fork.

Review 104 adds the optional typed `vimFiletype` getter/setter bridge. Adapter
mode reads/writes use the owning document's language override when bound; the
standalone adapter retains its local mode setting for compatibility. Oarlock
shares the override with syntax, formatting and LSP, and loads a structural XML
parser for tag text objects. No parser is loaded for unused languages.
